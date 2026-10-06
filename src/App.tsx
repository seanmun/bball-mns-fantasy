import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, useLocation, useParams } from 'react-router-dom'
import { Toaster } from 'sonner'
import { ScrollToTop } from './components/ScrollToTop'
import { UserSync } from './components/UserSync'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Header } from './components/Header'
import { Footer } from './components/Footer'
import { LeagueTopNav } from './components/LeagueTopNav'
import { LeagueBottomNav } from './components/LeagueBottomNav'
import { BumperPanel } from './components/BumperPanel'
import { useMediaQuery } from './hooks/useMediaQuery'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LeagueProvider, useLeague } from './contexts/LeagueContext'

// Eager — needed for initial render
import { Home } from './pages/Home'
import { Login } from './pages/Login'

// Public — lazy
const SignIn = lazy(() => import('./pages/SignIn').then((m) => ({ default: m.SignIn })))
const SignUp = lazy(() => import('./pages/SignUp').then((m) => ({ default: m.SignUp })))
const FinishSignIn = lazy(() => import('./pages/FinishSignIn').then((m) => ({ default: m.FinishSignIn })))
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })))
const Privacy = lazy(() => import('./pages/Privacy').then((m) => ({ default: m.Privacy })))
const Roadmap = lazy(() => import('./pages/Roadmap').then((m) => ({ default: m.Roadmap })))
const Changelog = lazy(() => import('./pages/Changelog').then((m) => ({ default: m.Changelog })))
const Media = lazy(() => import('./pages/Media').then((m) => ({ default: m.Media })))

// Authenticated
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })))
const TeamSelect = lazy(() => import('./pages/TeamSelect').then((m) => ({ default: m.TeamSelect })))
const CreateLeague = lazy(() => import('./pages/CreateLeague').then((m) => ({ default: m.CreateLeague })))

// League scope
const LeagueHome = lazy(() => import('./pages/LeagueHome').then((m) => ({ default: m.LeagueHome })))
const OwnerDashboard = lazy(() => import('./pages/OwnerDashboard').then((m) => ({ default: m.OwnerDashboard })))
const Draft = lazy(() => import('./pages/Draft').then((m) => ({ default: m.Draft })))
const MockDraft = lazy(() => import('./pages/MockDraft').then((m) => ({ default: m.MockDraft })))
const DraftHistory = lazy(() => import('./pages/DraftHistory').then((m) => ({ default: m.DraftHistory })))
const RookieDraft = lazy(() => import('./pages/RookieDraft').then((m) => ({ default: m.RookieDraft })))
const Prospects = lazy(() => import('./pages/Prospects').then((m) => ({ default: m.Prospects })))
const FreeAgents = lazy(() => import('./pages/FreeAgents').then((m) => ({ default: m.FreeAgents })))
const TradeMachine = lazy(() => import('./pages/TradeMachine').then((m) => ({ default: m.TradeMachine })))
const Inbox = lazy(() => import('./pages/Inbox').then((m) => ({ default: m.Inbox })))
const MatchupDetail = lazy(() => import('./pages/MatchupDetail').then((m) => ({ default: m.MatchupDetail })))
const LiveScores = lazy(() => import('./pages/LiveScores').then((m) => ({ default: m.LiveScores })))
const Prizes = lazy(() => import('./pages/Prizes').then((m) => ({ default: m.Prizes })))
const Keepers = lazy(() => import('./pages/Keepers').then((m) => ({ default: m.Keepers })))
const Rules = lazy(() => import('./pages/Rules').then((m) => ({ default: m.Rules })))
const RecordBook = lazy(() => import('./pages/RecordBook').then((m) => ({ default: m.RecordBook })))
const Standings = lazy(() => import('./pages/Standings').then((m) => ({ default: m.Standings })))
const Transactions = lazy(() => import('./pages/Transactions').then((m) => ({ default: m.Transactions })))

// League manager
const LeagueManagerHub = lazy(() => import('./pages/LeagueManagerHub').then((m) => ({ default: m.LeagueManagerHub })))
const AdminLeague = lazy(() => import('./pages/AdminLeague').then((m) => ({ default: m.AdminLeague })))
const AdminTeams = lazy(() => import('./pages/AdminTeams').then((m) => ({ default: m.AdminTeams })))
const AdminRosterManager = lazy(() => import('./pages/AdminRosterManager').then((m) => ({ default: m.AdminRosterManager })))
const AdminDraftSetup = lazy(() => import('./pages/AdminDraftSetup').then((m) => ({ default: m.AdminDraftSetup })))
const AdminDraftTest = lazy(() => import('./pages/AdminDraftTest').then((m) => ({ default: m.AdminDraftTest })))
const AdminDraftPicks = lazy(() => import('./pages/AdminDraftPicks').then((m) => ({ default: m.AdminDraftPicks })))
const AdminRookiePicks = lazy(() => import('./pages/AdminRookiePicks').then((m) => ({ default: m.AdminRookiePicks })))

// Site admin
const AdminHub = lazy(() => import('./pages/AdminHub').then((m) => ({ default: m.AdminHub })))
const AdminPlayers = lazy(() => import('./pages/AdminPlayers').then((m) => ({ default: m.AdminPlayers })))
const AdminUpload = lazy(() => import('./pages/AdminUpload').then((m) => ({ default: m.AdminUpload })))
const AdminProspects = lazy(() => import('./pages/AdminProspects').then((m) => ({ default: m.AdminProspects })))
const AdminMigration = lazy(() => import('./pages/AdminMigration').then((m) => ({ default: m.AdminMigration })))
const AdminPicksView = lazy(() => import('./pages/AdminPicksView').then((m) => ({ default: m.AdminPicksView })))
const AdminEmailTemplates = lazy(() => import('./pages/AdminEmailTemplates').then((m) => ({ default: m.AdminEmailTemplates })))
const AdminDataAudit = lazy(() => import('./pages/AdminDataAudit').then((m) => ({ default: m.AdminDataAudit })))

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-mns-dark">
      <div className="text-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-green-500 border-r-transparent" />
        <div className="mt-4 text-gray-400">Loading...</div>
      </div>
    </div>
  )
}

function AppLayout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <main className="flex-1">
        {/* Keyed by route: one page's crash must not poison the others. */}
        <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
      </main>
      <Footer />
    </div>
  )
}

function LeagueLayout({ children }: { children: React.ReactNode }) {
  // The URL is the single source of which league we're in. Syncing it
  // into LeagueContext here kills the localStorage drift where a
  // multi-league commissioner could land on /lm pages and silently edit
  // whichever league was persisted last.
  const { leagueId } = useParams()
  const { pathname } = useLocation()
  const { currentLeagueId, setCurrentLeagueId } = useLeague()
  useEffect(() => {
    if (leagueId && leagueId !== currentLeagueId) setCurrentLeagueId(leagueId)
  }, [leagueId, currentLeagueId, setCurrentLeagueId])

  // Bump has two homes: a sheet over the page on a phone, a panel docked
  // beside it from 1280px so a conversation and the roster share the
  // screen. Ask toggles whichever applies.
  const docked = useMediaQuery('(min-width: 1280px)')
  const [askOpen, setAskOpen] = useState(false)
  const panel = docked && askOpen

  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <LeagueTopNav />
      <div className={panel ? 'flex-1 grid grid-cols-[minmax(0,1fr)_22rem] items-stretch' : 'flex-1 flex flex-col'}>
        {/* pb clears the always-visible bottom tab bar */}
        <main className="flex-1 min-w-0 pb-16">
          {/* Keyed by route: one page's crash must not poison the others. */}
          <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
        </main>
        {panel ? (
          <div className="sticky top-0 h-screen min-h-0 pb-16">
            <BumperPanel
              leagueId={leagueId ?? ''}
              onClose={(acted) => {
                setAskOpen(false)
                if (acted) window.location.reload()
              }}
            />
          </div>
        ) : null}
      </div>
      <Footer />
      <LeagueBottomNav askOpen={askOpen} setAskOpen={setAskOpen} docked={docked} />
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-foreground)',
          },
          className: 'text-sm',
        }}
      />
      <UserSync />
      <LeagueProvider>
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            {/* Public */}
            <Route path="/" element={<AppLayout><Home /></AppLayout>} />
            <Route path="/login" element={<Login />} />
            <Route path="/sign-in/*" element={<SignIn />} />
            <Route path="/sign-up/*" element={<SignUp />} />
            <Route path="/finishSignIn" element={<FinishSignIn />} />
            <Route path="/about" element={<AppLayout><About /></AppLayout>} />
            <Route path="/privacy" element={<AppLayout><Privacy /></AppLayout>} />
            <Route path="/roadmap" element={<AppLayout><Roadmap /></AppLayout>} />
            <Route path="/changelog" element={<AppLayout><Changelog /></AppLayout>} />
            <Route path="/media" element={<AppLayout><Media /></AppLayout>} />

            {/* Authenticated */}
            <Route path="/profile" element={<ProtectedRoute><AppLayout><Profile /></AppLayout></ProtectedRoute>} />
            <Route path="/teams" element={<ProtectedRoute><AppLayout><TeamSelect /></AppLayout></ProtectedRoute>} />
            <Route path="/create-league" element={<ProtectedRoute><AppLayout><CreateLeague /></AppLayout></ProtectedRoute>} />

            {/* League scope */}
            <Route path="/league/:leagueId" element={<ProtectedRoute><LeagueLayout><LeagueHome /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/matchup/:matchupId" element={<ProtectedRoute><LeagueLayout><MatchupDetail /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/matchup" element={<ProtectedRoute><LeagueLayout><MatchupDetail /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/scores" element={<ProtectedRoute><LeagueLayout><LiveScores /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/prizes" element={<ProtectedRoute><LeagueLayout><Prizes /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/keepers" element={<ProtectedRoute><LeagueLayout><Keepers /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/team/:teamId" element={<ProtectedRoute><LeagueLayout><OwnerDashboard /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/my-team" element={<ProtectedRoute><LeagueLayout><OwnerDashboard /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/standings" element={<ProtectedRoute><LeagueLayout><Standings /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/transactions" element={<ProtectedRoute><LeagueLayout><Transactions /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/draft" element={<ProtectedRoute><LeagueLayout><Draft /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/free-agents" element={<ProtectedRoute><LeagueLayout><FreeAgents /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/record-book" element={<ProtectedRoute><LeagueLayout><RecordBook /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/rookie-draft" element={<ProtectedRoute><LeagueLayout><RookieDraft /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/rules" element={<ProtectedRoute><LeagueLayout><Rules /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/prospects" element={<ProtectedRoute><LeagueLayout><Prospects /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/mock-draft" element={<ProtectedRoute><LeagueLayout><MockDraft /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/draft-history" element={<ProtectedRoute><LeagueLayout><DraftHistory /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/trade-machine" element={<ProtectedRoute><LeagueLayout><TradeMachine /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/inbox" element={<ProtectedRoute><LeagueLayout><Inbox /></LeagueLayout></ProtectedRoute>} />

            {/* League manager — inside the league URL, so the league
                being managed is ALWAYS the one on screen, never
                whatever localStorage remembered. */}
            <Route path="/league/:leagueId/lm" element={<ProtectedRoute><LeagueLayout><LeagueManagerHub /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/lm/league" element={<ProtectedRoute><LeagueLayout><AdminLeague /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/lm/teams" element={<ProtectedRoute><LeagueLayout><AdminTeams /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/lm/rosters" element={<ProtectedRoute><LeagueLayout><AdminRosterManager /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/lm/draft-setup" element={<ProtectedRoute><LeagueLayout><AdminDraftSetup /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/lm/draft-test" element={<ProtectedRoute><LeagueLayout><AdminDraftTest /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/lm/draft-picks" element={<ProtectedRoute><LeagueLayout><AdminDraftPicks /></LeagueLayout></ProtectedRoute>} />
            <Route path="/league/:leagueId/lm/rookie-picks" element={<ProtectedRoute><LeagueLayout><AdminRookiePicks /></LeagueLayout></ProtectedRoute>} />

            {/* Site admin */}
            <Route path="/site-admin" element={<ProtectedRoute><AppLayout><AdminHub /></AppLayout></ProtectedRoute>} />
            <Route path="/admin/players" element={<ProtectedRoute><AppLayout><AdminPlayers /></AppLayout></ProtectedRoute>} />
            <Route path="/admin/upload" element={<ProtectedRoute><AppLayout><AdminUpload /></AppLayout></ProtectedRoute>} />
            <Route path="/admin/prospects" element={<ProtectedRoute><AppLayout><AdminProspects /></AppLayout></ProtectedRoute>} />
            <Route path="/admin/migration" element={<ProtectedRoute><AppLayout><AdminMigration /></AppLayout></ProtectedRoute>} />
            <Route path="/admin/picks" element={<ProtectedRoute><AppLayout><AdminPicksView /></AppLayout></ProtectedRoute>} />
            <Route path="/admin/email-templates" element={<ProtectedRoute><AppLayout><AdminEmailTemplates /></AppLayout></ProtectedRoute>} />
            <Route path="/admin/data-audit" element={<ProtectedRoute><AppLayout><AdminDataAudit /></AppLayout></ProtectedRoute>} />
          </Routes>
        </Suspense>
      </LeagueProvider>
    </BrowserRouter>
  )
}
