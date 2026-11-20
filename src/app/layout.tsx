import type { Metadata, Viewport } from "next"
import Script from "next/script"
import "./globals.css"
import { FullStoryScript } from "./components/fullstory-script"

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content" }

export const metadata: Metadata = {
    title: "FedFlow | BioGuide voice desk",
    description:
        "Ask about public congressional biographies and draft a cited handoff for the next researcher.",
    openGraph: {
        title: "FedFlow | BioGuide voice desk",
        description: "Turn a BioGuide voice conversation into a research handoff with public sources.",
        images: ["https://www.elastic.co/static-res/images/social_media_default.png"],
    },
}

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode
}>) {
    const rumServerUrl = process.env.NEXT_PUBLIC_ELASTIC_APM_SERVER_URL
    const rumServiceName = process.env.NEXT_PUBLIC_ELASTIC_APM_SERVICE_NAME
    const rumEnvironment = process.env.NEXT_PUBLIC_ELASTIC_APM_ENVIRONMENT || process.env.NODE_ENV || "development"
    const rumServiceVersion = process.env.NEXT_PUBLIC_ELASTIC_APM_SERVICE_VERSION || process.env.APP_VERSION || "0.13.3"
    const shouldInitRum = Boolean(rumServerUrl && rumServiceName)

    const rumInitConfig = shouldInitRum
        ? JSON.stringify({
              serviceName: rumServiceName,
              serverUrl: rumServerUrl,
              environment: rumEnvironment,
              breakdownMetrics: true,
              serviceVersion: rumServiceVersion,
          })
        : ""

    return (
        <html lang="en">
            <head>
                {shouldInitRum ? (
                    <>
                        <Script
                            src="https://unpkg.com/@elastic/apm-rum/dist/bundles/elastic-apm-rum.umd.min.js"
                            strategy="beforeInteractive"
                            crossOrigin="anonymous"
                        />
                        <Script id="elastic-apm-init" strategy="beforeInteractive">
                            {`window.elasticApm && window.elasticApm.init(${rumInitConfig});`}
                        </Script>
                    </>
                ) : null}
                <FullStoryScript />
            </head>
            <body className={`antialiased`}>{children}</body>
        </html>
    )
}
