import { useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'
import { useLeague } from '../contexts/LeagueContext'
import { sport } from '../lib/sport/index'
import { branding } from '../lib/branding'

const capM = `$${(sport.preset.cap.base / 1_000_000).toFixed(1)}M`

export function Home() {
  const navigate = useNavigate()
  const { isLoaded, isSignedIn } = useAuth()
  const { userLeagues, loading: leaguesLoading } = useLeague()

  useEffect(() => {
    if (!isLoaded || leaguesLoading) return
    if (!isSignedIn) return
    if (userLeagues.length === 0) navigate('/teams')
    else if (userLeagues.length === 1) navigate(`/league/${userLeagues[0].id}`)
    else navigate('/teams')
  }, [isLoaded, isSignedIn, userLeagues, leaguesLoading, navigate])

  // Center-ball video has a blank frame at ~19.5s; loop before it hits.
  const handleCenterBallLoop = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const video = e.currentTarget
      if (video.currentTime >= 19.5) video.currentTime = 0
    },
    []
  )

  const scrollToFeatures = () => {
    document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })
  }

  if (!isLoaded || (isSignedIn && leaguesLoading)) {
    return (
      <div className="min-h-screen bg-mns-dark flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-green-500 border-r-transparent" />
          <div className="mt-4 text-gray-400">Loading...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-mns-dark text-white">
      {/* Hero */}
      <div className="relative overflow-hidden">
        <video
          autoPlay loop muted playsInline
          className="absolute inset-0 w-full h-full object-cover opacity-15 hidden md:block"
        >
          <source src={branding.assets.heroVideoDesktop} type="video/mp4" />
        </video>
        <video
          autoPlay loop muted playsInline
          className="absolute inset-0 w-full h-full object-cover opacity-15 md:hidden"
          onTimeUpdate={handleCenterBallLoop}
        >
          <source src={branding.assets.heroVideoMobile} type="video/mp4" />
        </video>

        <div className="absolute inset-0 bg-gradient-to-br from-green-400/10 via-purple-400/10 to-pink-400/10" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16">
          <div className="text-center">
            <div className="flex justify-center mb-8">
              <img
                src={branding.assets.logo}
                alt={branding.identity.longName}
                className="w-32 h-32 sm:w-40 sm:h-40 rounded-full shadow-2xl ring-4 ring-green-400/30"
              />
            </div>

            <h1 className="text-5xl sm:text-7xl font-bold mb-4 bg-gradient-to-r from-green-400 via-emerald-400 to-green-500 bg-clip-text text-transparent">
              Money Never Sleeps
            </h1>

            <div className="inline-flex items-center gap-2 px-6 py-2 mb-6 bg-pink-400/10 border-2 border-pink-400 rounded-full text-pink-400 text-base sm:text-lg font-bold tracking-widest uppercase shadow-[0_0_30px_rgba(244,114,182,0.5)]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-pink-400"></span>
              </span>
              {sport.leagueLabel} Edition · {branding.identity.seasonLabel.split(' ')[0]}
            </div>

            <p className="text-xl sm:text-2xl text-gray-300 mb-4 max-w-3xl mx-auto">
              Where Fantasy {sport.leagueLabel} Meets Wall Street
            </p>

            <p className="text-lg text-gray-400 mb-8 max-w-3xl mx-auto">
              Navigate the {sport.leagueLabel} salary cap, manage keeper contracts with advancing rounds, and make strategic decisions with real monetary consequences. Every fee compounds the prize pool — sweat your matchups and your portfolio, because money never sleeps.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              <Link
                to="/sign-in"
                className="w-full sm:w-auto px-8 py-4 border-2 border-green-400 text-green-400 rounded-lg text-lg font-bold hover:bg-green-400/10 hover:shadow-[0_0_30px_rgba(74,222,128,0.6)] transition-all"
              >
                Sign In
              </Link>
              <button
                onClick={scrollToFeatures}
                className="w-full sm:w-auto px-8 py-4 border-2 border-gray-700 text-gray-300 rounded-lg text-lg font-semibold hover:border-green-400 hover:text-green-400 hover:bg-green-400/10 transition-all cursor-pointer"
              >
                Learn More
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Features */}
      <div id="features" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-bold mb-4">What Makes {sport.appName} Special</h2>
          <p className="text-gray-400 text-lg">A sophisticated platform for serious dynasty {sport.leagueLabel} owners</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {/* Salary Cap */}
          <div className="bg-mns-card rounded-lg border border-gray-800 p-8 hover:border-green-400/50 transition-all hover:shadow-[0_0_20px_rgba(74,222,128,0.2)]">
            <div className="flex items-center gap-3 mb-4">
              <img src="/icons/money-icon.webp" alt="Salary Cap" className="w-12 h-12 rounded-full" />
              <h3 className="text-xl font-bold">{sport.leagueLabel} Salary Cap</h3>
            </div>
            <p className="text-gray-400 mb-4">
              Operate inside the real {capM} {sport.leagueLabel} cap. Every contract is a trade-off — there's no room for waste.
            </p>
            <ul className="space-y-2 text-sm text-gray-400">
              <li className="flex items-start gap-2"><span className="text-green-400 flex-shrink-0">•</span><span>Tight {capM} ceiling enforced live</span></li>
              <li className="flex items-start gap-2"><span className="text-green-400 flex-shrink-0">•</span><span>Trade-cap flexibility per commissioner config</span></li>
              <li className="flex items-start gap-2"><span className="text-green-400 flex-shrink-0">•</span><span>Visual cap thermometer + fee preview</span></li>
            </ul>
          </div>

          {/* Dynasty Keepers */}
          <div className="bg-mns-card rounded-lg border border-gray-800 p-8 hover:border-purple-400/50 transition-all hover:shadow-[0_0_20px_rgba(192,132,252,0.2)]">
            <div className="flex items-center gap-3 mb-4">
              <img src="/icons/lock-icon.webp" alt="Keepers" className="w-12 h-12 rounded-full" />
              <h3 className="text-xl font-bold">Dynasty Keeper System</h3>
            </div>
            <p className="text-gray-400 mb-4">
              Keep up to 5 players season-over-season. Build a real dynasty with strategic round management.
            </p>
            <ul className="space-y-2 text-sm text-gray-400">
              <li className="flex items-start gap-2"><span className="text-purple-400 flex-shrink-0">•</span><span>Keepers advance one round each year</span></li>
              <li className="flex items-start gap-2"><span className="text-purple-400 flex-shrink-0">•</span><span>Franchise tags for multiple stars</span></li>
              <li className="flex items-start gap-2"><span className="text-purple-400 flex-shrink-0">•</span><span>Smart stacking resolves round conflicts</span></li>
            </ul>
          </div>

          {/* Rookie Pipeline */}
          <div className="bg-mns-card rounded-lg border border-gray-800 p-8 hover:border-pink-400/50 transition-all hover:shadow-[0_0_20px_rgba(244,114,182,0.2)]">
            <div className="flex items-center gap-3 mb-4">
              <img src="/icons/rookie-icon.webp" alt="Rookies" className="w-12 h-12 rounded-full" />
              <h3 className="text-xl font-bold">Rookie Pipeline</h3>
            </div>
            <p className="text-gray-400 mb-4">
              Stash rookies for $10, activate mid-season for $25. Annual rookie draft mirrors the W with lottery odds.
            </p>
            <ul className="space-y-2 text-sm text-gray-400">
              <li className="flex items-start gap-2"><span className="text-pink-400 flex-shrink-0">•</span><span>Redshirt system for first-year stash plays</span></li>
              <li className="flex items-start gap-2"><span className="text-pink-400 flex-shrink-0">•</span><span>Two-round rookie draft with lottery</span></li>
              <li className="flex items-start gap-2"><span className="text-pink-400 flex-shrink-0">•</span><span>International stash for overseas prospects</span></li>
            </ul>
          </div>

          {/* Live Draft */}
          <div className="bg-mns-card rounded-lg border border-gray-800 p-8 hover:border-blue-400/50 transition-all hover:shadow-[0_0_20px_rgba(96,165,250,0.2)]">
            <div className="flex items-center gap-3 mb-4">
              <img src="/icons/draft-icon.webp" alt="Draft" className="w-12 h-12 rounded-full" />
              <h3 className="text-xl font-bold">Live Draft Board</h3>
            </div>
            <p className="text-gray-400 mb-4">
              10-round snake draft with live updates and Telegram pick notifications tagging each owner.
            </p>
            <ul className="space-y-2 text-sm text-gray-400">
              <li className="flex items-start gap-2"><span className="text-blue-400 flex-shrink-0">•</span><span>Keepers auto-fill their assigned rounds</span></li>
              <li className="flex items-start gap-2"><span className="text-blue-400 flex-shrink-0">•</span><span>Real-time Telegram pick announcements</span></li>
              <li className="flex items-start gap-2"><span className="text-blue-400 flex-shrink-0">•</span><span>Admin override tools for commissioners</span></li>
            </ul>
          </div>

          {/* Prize Pool */}
          <div className="bg-mns-card rounded-lg border border-gray-800 p-8 hover:border-yellow-400/50 transition-all hover:shadow-[0_0_20px_rgba(250,204,21,0.2)]">
            <div className="flex items-center gap-3 mb-4">
              <img src="/icons/trophy-icon.webp" alt="Prize Pool" className="w-12 h-12 rounded-full" />
              <h3 className="text-xl font-bold">Prize Pool Zones</h3>
            </div>
            <p className="text-gray-400 mb-4">
              Buy-ins plus every penalty fund the pool. By playoffs it could be Boiler Room, Gekko, or Bernie territory.
            </p>
            <ul className="space-y-2 text-sm text-gray-400">
              <li className="flex items-start gap-2"><span className="text-yellow-400 flex-shrink-0">•</span><span>Boiler Room: 100% to 1st (pool &lt; $300)</span></li>
              <li className="flex items-start gap-2"><span className="text-yellow-400 flex-shrink-0">•</span><span>Gordon Gekko: 70/20/10 to top 3</span></li>
              <li className="flex items-start gap-2"><span className="text-yellow-400 flex-shrink-0">•</span><span>Bernie Zone: tiered for $10K+ pools</span></li>
            </ul>
          </div>

          {/* Analytics */}
          <div className="bg-mns-card rounded-lg border border-gray-800 p-8 hover:border-emerald-400/50 transition-all hover:shadow-[0_0_20px_rgba(52,211,153,0.2)]">
            <div className="flex items-center gap-3 mb-4">
              <img src="/icons/settings-icon.webp" alt="Analytics" className="w-12 h-12 rounded-full" />
              <h3 className="text-xl font-bold">Advanced Analytics</h3>
            </div>
            <p className="text-gray-400 mb-4">
              Cap thermometer, scenario planning, projected + previous-season stats — the math behind every decision.
            </p>
            <ul className="space-y-2 text-sm text-gray-400">
              <li className="flex items-start gap-2"><span className="text-emerald-400 flex-shrink-0">•</span><span>Real-time cap usage and fee preview</span></li>
              <li className="flex items-start gap-2"><span className="text-emerald-400 flex-shrink-0">•</span><span>Save and compare multiple keeper scenarios</span></li>
              <li className="flex items-start gap-2"><span className="text-emerald-400 flex-shrink-0">•</span><span>9-cat projections and prior-year stats</span></li>
            </ul>
          </div>
        </div>
      </div>

      {/* How It Works */}
      <div className="bg-gradient-to-br from-gray-900 to-[#0a0a0a] py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">How It Works</h2>
            <p className="text-gray-400 text-lg">Four phases. One dynasty.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 bg-green-400/20 rounded-full flex items-center justify-center border-2 border-green-400">
                  <span className="text-2xl font-bold text-green-400">1</span>
                </div>
              </div>
              <h3 className="text-xl font-bold mb-3">Keeper Selection</h3>
              <p className="text-gray-400 text-sm">
                Review your roster, pick up to 5 keepers, manage cap usage, and pay franchise tags for your stars.
              </p>
            </div>

            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 bg-purple-400/20 rounded-full flex items-center justify-center border-2 border-purple-400">
                  <span className="text-2xl font-bold text-purple-400">2</span>
                </div>
              </div>
              <h3 className="text-xl font-bold mb-3">Draft</h3>
              <p className="text-gray-400 text-sm">
                10-round snake. Keepers fill their assigned slots; new picks fill the rest. Telegram bot calls every selection.
              </p>
            </div>

            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 bg-pink-400/20 rounded-full flex items-center justify-center border-2 border-pink-400">
                  <span className="text-2xl font-bold text-pink-400">3</span>
                </div>
              </div>
              <h3 className="text-xl font-bold mb-3">Regular Season</h3>
              <p className="text-gray-400 text-sm">
                13 weeks of head-to-head matchups across 9 cats. Trade inside the cap, activate redshirts, sweat lineups.
              </p>
            </div>

            <div className="text-center">
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 bg-yellow-400/20 rounded-full flex items-center justify-center border-2 border-yellow-400">
                  <span className="text-2xl font-bold text-yellow-400">4</span>
                </div>
              </div>
              <h3 className="text-xl font-bold mb-3">Playoffs & Payout</h3>
              <p className="text-gray-400 text-sm">
                Top 6 teams compete in a 3-round bracket. Prize pool pays out by zone — banner forever, money tomorrow.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Final CTA */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h2 className="text-4xl font-bold mb-6">Ready to Build Your Dynasty?</h2>
        <p className="text-xl text-gray-400 mb-8">
          The most sophisticated fantasy {sport.leagueLabel} league on the internet. Strategy, finance, hoops.
        </p>
        <Link
          to="/sign-in"
          className="inline-block px-12 py-5 border-2 border-green-400 text-green-400 rounded-lg text-xl font-bold hover:bg-green-400/10 hover:shadow-[0_0_40px_rgba(74,222,128,0.8)] transition-all"
        >
          Sign In
        </Link>
        <p className="text-sm text-gray-500 mt-4">
          Sign in with Google or email — your seat is one click away.
        </p>
      </div>
    </div>
  )
}
