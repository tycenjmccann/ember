import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import TopBar from "@/components/layout/TopBar";

export const metadata: Metadata = {
  title: "Cloud Code",
  description: "A resumable coding agent that runs in the cloud. Close the lid, resume anywhere.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Cloud Code" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
            <TopBar />
            <main className="flex-1 min-h-0">{children}</main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
