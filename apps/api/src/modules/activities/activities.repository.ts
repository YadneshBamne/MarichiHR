import { prisma } from '../../infrastructure/database/prisma'
import { CreateActivityDto } from './activities.types'

export const activitiesRepository = {
  // ─── ACTIVITIES ───────────────────────────────────────────
  async create(tenantId: string, createdBy: string, data: CreateActivityDto) {
    return prisma.activity.create({
      data: {
        tenantId,
        activityTypeId: data.activityTypeId,
        entityType: data.entityType,
        entityId: data.entityId,
        title: data.title,
        note: data.note,
        assignedToId: data.assignedToId,
        createdBy,
        dueDate: new Date(data.dueDate),
        status: 'planned',
      },
      include: {
        activityType: true,
        assignee: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
      },
    })
  },

  async listForEntity(entityType: string, entityId: string, tenantId: string) {
    return prisma.activity.findMany({
      where: { entityType, entityId, tenantId },
      include: {
        activityType: true,
        assignee: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
      },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    })
  },

  async listMyActivities(assignedToId: string, status?: string) {
    return prisma.activity.findMany({
      where: {
        assignedToId,
        ...(status ? { status } : { status: { in: ['planned', 'overdue'] } }),
      },
      include: { activityType: true },
      orderBy: { dueDate: 'asc' },
    })
  },

  async complete(id: string, doneNote: string) {
    return prisma.activity.update({
      where: { id },
      data: { status: 'done', doneAt: new Date(), doneNote },
    })
  },

  async cancel(id: string) {
    return prisma.activity.update({
      where: { id },
      data: { status: 'cancelled' },
    })
  },

  // ─── CHATTER ──────────────────────────────────────────────
  async createMessage(data: {
    tenantId: string
    entityType: string
    entityId: string
    body: string
    authorId?: string
    authorName?: string
    messageType: string
    isInternal: boolean
  }) {
    return prisma.chatterMessage.create({
      data: {
        tenantId: data.tenantId,
        entityType: data.entityType,
        entityId: data.entityId,
        body: data.body,
        authorId: data.authorId,
        authorName: data.authorName,
        messageType: data.messageType,
        isInternal: data.isInternal,
      },
      include: {
        author: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
      },
    })
  },

  async listMessages(tenantId: string, entityType: string, entityId: string, includeInternal: boolean = false) {
    return prisma.chatterMessage.findMany({
      where: {
        tenantId,
        entityType,
        entityId,
        ...(includeInternal ? {} : { isInternal: false }),
      },
      include: {
        author: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  // ─── AUDIT LOG ────────────────────────────────────────────
  async createAuditLog(data: {
    tenantId: string
    userId?: string
    action: string
    entityType: string
    entityId: string
    oldValue?: any
    newValue?: any
    ipAddress?: string
  }) {
    return prisma.auditLog.create({ data })
  },
}

// ─── SYSTEM CHATTER LOGGER ────────────────────────────────────
export async function logSystemChatter(
  tenantId: string,
  entityType: string,
  entityId: string,
  message: string
) {
  return prisma.chatterMessage.create({
    data: {
      tenantId,
      entityType,
      entityId,
      body: message,
      authorId: null,
      authorName: 'System',
      messageType: 'system_log',
      isInternal: false,
    },
  })
}
