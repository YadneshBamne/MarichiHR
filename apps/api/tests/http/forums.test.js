// Community: spaces, threads with polls, comments, @mentions, kudos on the recognition wall, reports and moderation.
const { api, tokenFor, check, done, prisma } = require('./lib')

const TAG = `fo${Date.now() % 1e7}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const admin = await tokenFor('admin@marichihr.com') // HR: moderator
  const john = await tokenFor('john.banda@marichihr.com')
  const jane = await tokenFor('jane.mutale@marichihr.com')
  const made = { threads: [], kudos: [], spaces: [] }

  let r = await api(jane, 'GET', '/forums/spaces')
  const general = r.body.find((s) => s.name === 'General')
  check('every company has a General space', r.status === 200 && !!general, r.body)
  r = await api(jane, 'POST', '/forums/spaces', { name: `Jane ${TAG}` })
  check('only HR creates spaces (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', '/forums/spaces', { name: `Sports ${TAG}`, description: 'Cricket and football' })
  made.spaces.push(r.body?.id)
  check('HR creates a space', r.status === 201, r.data)

  // ─── Thread with a poll and a mention ─────────────────────
  r = await api(john, 'POST', '/forums/threads', { spaceId: general.id, title: `Team lunch ${TAG}`, body: 'Where shall we go on Friday?', mentions: [jane.employeeId], poll: { question: 'Pick a place', options: ['Pizza', 'Nshima', 'Sushi'] } })
  const thread = r.body
  made.threads.push(thread?.id)
  check('John starts a thread with a poll', r.status === 201, r.data)
  let mention = null
  for (let i = 0; i < 20 && !mention; i++) { mention = await prisma.notification.findFirst({ where: { userId: jane.userId, type: 'forum.mention', entityId: thread.id } }); if (!mention) await sleep(300) }
  check('Jane is notified that she was mentioned', !!mention)
  r = await api(jane, 'GET', `/forums/threads/${thread.id}`)
  const opts = r.body.poll.options
  check('the thread shows the poll with three options', r.status === 200 && opts.length === 3 && r.body.poll.voters === 0, r.body?.poll)
  r = await api(jane, 'POST', `/forums/threads/${thread.id}/vote`, { optionIds: [opts[0].id, opts[1].id] })
  check('a single-choice poll takes one option (400)', r.status === 400, r.data)
  r = await api(jane, 'POST', `/forums/threads/${thread.id}/vote`, { optionIds: [opts[1].id] })
  check('Jane votes', r.status === 200 && r.body.options[1].votes === 1 && r.body.mine[0] === opts[1].id, r.body)
  r = await api(jane, 'POST', `/forums/threads/${thread.id}/vote`, { optionIds: [opts[2].id] })
  check('…and can change her vote (still one voter)', r.body.voters === 1 && r.body.options[2].votes === 1 && r.body.options[1].votes === 0, r.body)

  r = await api(jane, 'POST', `/forums/threads/${thread.id}/comments`, { body: 'Sushi please!' })
  const comment = r.body
  check('Jane comments', r.status === 201, r.data)
  check('the author hears about the reply', !!(await prisma.notification.findFirst({ where: { userId: john.userId, type: 'forum.reply', entityId: thread.id } })))
  r = await api(jane, 'GET', `/forums/threads?spaceId=${general.id}&q=${TAG}`)
  check('the thread is listed and searchable with its comment count', r.body.some((t) => t.id === thread.id && t.comments === 1 && t.hasPoll), r.body)

  // ─── Moderation ───────────────────────────────────────────
  r = await api(jane, 'POST', `/forums/threads/${thread.id}/moderate`, { pinned: true })
  check('employees cannot moderate (403)', r.status === 403, r.status)
  r = await api(admin, 'POST', `/forums/threads/${thread.id}/moderate`, { pinned: true, locked: true })
  check('HR pins and locks the thread', r.status === 200, r.data)
  r = await api(jane, 'POST', `/forums/threads/${thread.id}/comments`, { body: 'Too late?' })
  check('a locked thread takes no new comments (400)', r.status === 400, r.data)

  r = await api(john, 'POST', '/forums/reports', { targetType: 'comment', targetId: comment.id, reason: 'Off topic' })
  check('John reports a comment', r.status === 201, r.data)
  r = await api(jane, 'GET', '/forums/reports')
  check('only HR sees reports (403)', r.status === 403, r.status)
  r = await api(admin, 'GET', '/forums/reports')
  const report = r.body.find((x) => x.targetId === comment.id)
  check('HR sees the report with the content', !!report && report.content === 'Sushi please!', r.body)
  r = await api(admin, 'POST', `/forums/reports/${report.id}/resolve`, { hide: true })
  check('HR hides it', r.status === 200 && r.body.resolution === 'hidden', r.data)
  r = await api(jane, 'GET', `/forums/threads/${thread.id}`)
  check('hidden comments disappear for everyone else', r.body.comments.length === 0, r.body.comments)

  // ─── Recognition wall ─────────────────────────────────────
  r = await api(jane, 'POST', '/forums/kudos', { toEmployeeId: jane.employeeId, badge: 'teamwork', message: 'Me!' })
  check('no kudos to yourself (400)', r.status === 400, r.status)
  r = await api(jane, 'POST', '/forums/kudos', { toEmployeeId: john.employeeId, badge: 'leadership', message: `Thanks for the lunch idea ${TAG}` })
  made.kudos.push(r.body?.id)
  check('Jane gives John kudos', r.status === 201, r.data)
  check('…John is notified', !!(await prisma.notification.findFirst({ where: { userId: john.userId, type: 'kudos.received', entityId: r.body.id } })))
  r = await api(john, 'GET', '/forums/kudos')
  check('the wall shows it with names and badge', r.body.some((k) => k.message.includes(TAG) && k.badge === 'leadership' && k.to && k.from), r.body?.slice(0, 2))

  const foreign = await prisma.forumThread.findFirst({ where: { tenantId: { not: admin.tenantId } } })
  if (foreign) {
    r = await api(jane, 'GET', `/forums/threads/${foreign.id}`)
    check("another company's thread is invisible (404)", r.status === 404, r.status)
  }

  await prisma.forumThread.updateMany({ where: { id: { in: made.threads.filter(Boolean) } }, data: { hidden: true } })
  await prisma.kudos.updateMany({ where: { id: { in: made.kudos.filter(Boolean) } }, data: { hidden: true } })
  await prisma.forumSpace.updateMany({ where: { id: { in: made.spaces.filter(Boolean) } }, data: { active: false } })
  await done()
})()
