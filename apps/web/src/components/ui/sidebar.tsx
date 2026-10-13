import React, { createContext, useContext, useEffect, useState } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { Menu, X } from 'lucide-react'

// Hover-expanding sidebar (after Aceternity's sidebar): a 60px icon rail on desktop that widens to 300px (the page
// narrows with it) while the pointer or keyboard focus is inside it, and a top bar with a full-screen menu on small screens. Styled by the
// .sb-* classes in styles/theme.css.

const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

interface Links {
  label: string
  href: string
  icon: React.ReactNode
}

interface SidebarContextProps {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  animate: boolean
}

const SidebarContext = createContext<SidebarContextProps | undefined>(undefined)

export const useSidebar = () => {
  const context = useContext(SidebarContext)
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider')
  return context
}

export const SidebarProvider = ({ children, open: openProp, setOpen: setOpenProp, animate = true }: {
  children: React.ReactNode
  open?: boolean
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>
  animate?: boolean
}) => {
  const [openState, setOpenState] = useState(false)
  const open = openProp !== undefined ? openProp : openState
  const setOpen = setOpenProp !== undefined ? setOpenProp : setOpenState
  return (
    <SidebarContext.Provider value={{ open, setOpen, animate }}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </SidebarContext.Provider>
  )
}

export const Sidebar = ({ children, open, setOpen, animate }: {
  children: React.ReactNode
  open?: boolean
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>
  animate?: boolean
}) => (
  <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
    {children}
  </SidebarProvider>
)

// `mobileStart` sits at the left of the small-screen bar (the menu button is on the right)
export const SidebarBody = ({ mobileStart, ...props }: React.ComponentProps<typeof motion.div> & { mobileStart?: React.ReactNode }) => (
  <>
    <DesktopSidebar {...props} />
    <MobileSidebar className={props.className} start={mobileStart}>{props.children as React.ReactNode}</MobileSidebar>
  </>
)

export const DesktopSidebar = ({ className, children, ...props }: React.ComponentProps<typeof motion.div>) => {
  const { open, setOpen, animate } = useSidebar()
  return (
    <motion.div
      className={cn('sb-desktop', className)}
      data-open={open ? '1' : '0'}
      initial={false}
      animate={{ width: animate ? (open ? '300px' : '60px') : '300px' }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      // Keyboard users get the labels too: open while focus is inside, close when it leaves
      onFocus={() => setOpen(true)}
      onBlur={(e: React.FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }}
      {...props}
    >
      {children}
    </motion.div>
  )
}

export const MobileSidebar = ({ className, children, start }: { className?: string; children: React.ReactNode; start?: React.ReactNode }) => {
  const { open, setOpen } = useSidebar()
  // The full-screen menu is the only thing that scrolls while it is open (phones only; on desktop `open` means hover)
  useEffect(() => {
    if (!open || !window.matchMedia('(max-width: 1023px)').matches) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])
  return (
    <div className="sb-mobile-bar">
      {start}
      <button type="button" className="sb-icon-btn" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Menu size={20} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: '-100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '-100%', opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className={cn('sb-mobile-panel', className)}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
          >
            <button type="button" className="sb-icon-btn sb-close" aria-label="Close navigation" onClick={() => setOpen(false)}>
              <X size={20} />
            </button>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// A nav link: icon, then a label that shows only while the sidebar is open. Extra link props (title, aria-current,
// data-*) pass straight through; children render after the label (badges).
export const SidebarLink = ({ link, className, children, ...props }: { link: Links; className?: string } & Omit<LinkProps, 'to' | 'className'>) => {
  const { open, animate } = useSidebar()
  const shown = !animate || open
  return (
    <Link to={link.href} className={cn('sb-link', className)} {...props}>
      {link.icon}
      <motion.span
        initial={false}
        animate={{ display: shown ? 'inline-block' : 'none', opacity: shown ? 1 : 0 }}
        className="sb-label"
      >
        {link.label}
      </motion.span>
      {children}
    </Link>
  )
}
