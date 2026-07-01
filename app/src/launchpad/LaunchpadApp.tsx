/// Standalone launchpad SPA shell (served at launchpad.openperps.fun). Shares the
/// main app's providers (wallet, react-query) and the global openperps theme, but
/// renders its own launchpad header + pages instead of the trading app.

import { ArrowUpRight } from "lucide-react";

import logo from "@/assets/openperps-logo.png";
import { WalletButton } from "@/components/openperps/WalletButton";
import { Button } from "@/components/ui/button";

import { useHashRoute } from "./useHashRoute";
import { mainAppUrl } from "./lib";
import { Home } from "./Home";
import { Create } from "./Create";
import { Coin } from "./Coin";
import { Profile } from "./Profile";

export function LaunchpadApp() {
  const [route, nav] = useHashRoute();

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ambient neon wash, matches the main app's hero treatment */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-60"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -10%, rgba(46,230,194,0.10), transparent 70%), var(--background)",
        }}
      />

      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="relative mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <button
            type="button"
            onClick={() => nav("/")}
            className="flex items-center gap-2.5 group"
          >
            <img
              src={logo}
              alt="OpenPerps"
              className="h-8 w-8 drop-shadow-[0_0_10px_oklch(0.86_0.16_188_/_0.6)]"
            />
            <span className="font-display text-[17px] font-semibold tracking-tight">
              Open<span className="text-neon">Perps</span>
            </span>
          </button>

          <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 md:flex">
            <HeaderLink active={route.name === "home"} onClick={() => nav("/")}>
              Explore
            </HeaderLink>
            <HeaderLink active={route.name === "create"} onClick={() => nav("/create")}>
              Create
            </HeaderLink>
            <HeaderLink active={route.name === "profile"} onClick={() => nav("/profile")}>
              Profile
            </HeaderLink>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                window.location.href = mainAppUrl("/terminal");
              }}
              className="gap-1.5"
            >
              <ArrowUpRight className="h-3.5 w-3.5" /> Trade perps
            </Button>
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {route.name === "home" && <Home onOpen={(mint) => nav(`/coin/${mint}`)} onCreate={() => nav("/create")} />}
        {route.name === "create" && <Create onLaunched={(mint) => nav(`/coin/${mint}`)} />}
        {route.name === "coin" && <Coin mint={route.mint} onBack={() => nav("/")} />}
        {route.name === "profile" && (
          <Profile address={route.address} onOpen={(mint) => nav(`/coin/${mint}`)} onBack={() => nav("/")} />
        )}
      </main>
    </div>
  );
}

function HeaderLink({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "text-neon" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
