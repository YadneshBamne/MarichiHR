// Demo sign-in buttons on the login page (Marichi Labs demo workspace), for presentations.
// Paste each account's password between the quotes. A button only shows once its password is filled in.
// These are DEMO accounts and become visible to anyone: delete this file (and its import in LoginPage) to remove the
// buttons, and change these passwords after the demo.
export interface DemoLogin { label: string; email: string; password: string }
export const DEMO_ORG = 'marichilabs-hr'
export const DEMO_LOGINS: DemoLogin[] = ([
  { label: 'HR / Admin', email: 'hanumant@marichilabs.com', password: '' }, // Hanumant Shukla
  { label: 'Manager', email: 'meera@marichilabs.com', password: '' }, // Meera Iyer (team: Rohan, Sneha)
  { label: 'Employee', email: 'rohan@marichilabs.com', password: '' }, // Rohan Deshmukh (reports to Meera)
] as DemoLogin[]).filter((d) => d.password)
