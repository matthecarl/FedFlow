import type { NextConfig } from "next"
import { withWorkflow } from "workflow/next"
import packageJson from "./package.json"

const nextConfig: NextConfig = {
    reactCompiler: true,
    env: {
        APP_VERSION: packageJson.version,
    },
    productionBrowserSourceMaps: true,
}

export default withWorkflow(nextConfig)
