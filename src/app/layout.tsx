import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import TopBar from "@/components/layout/TopBar";

export const metadata: Metadata = {
  title: "Ember",
  description: "Keep your session warm. A resumable coding agent that runs in your own AWS account.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Ember" },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#f2efe9" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Runtime-evaluated (server component): auth is on when a pool is wired and not
  // explicitly disabled. NOT a NEXT_PUBLIC_ build-time var — the App Runner image
  // is prebuilt, so those would bake in stale.
  const authEnabled =
    Boolean(process.env.COGNITO_USER_POOL_ID) && process.env.EMBER_AUTH_DISABLED !== "1";
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('theme');
                  if (!theme) {
                    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
                  }
                  document.documentElement.setAttribute('data-theme', theme);
                } catch (e) {
                  document.documentElement.setAttribute('data-theme', 'dark');
                }
              })();
            `,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <div className="flex flex-col h-[100dvh] overflow-hidden">
            <TopBar authEnabled={authEnabled} />
            <main className="flex-1 min-h-0">{children}</main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
