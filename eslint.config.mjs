import eslint from "@eslint/js"
import nextCoreWebVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

const config = [
    // Keep this near the top so tooling doesn't waste time in generated output.
    { ignores: [".next/**", "node_modules/**", "src/app/.well-known/workflow/**", ".workflow-data/**"] },
    eslint.configs.recommended,
    ...nextCoreWebVitals,
    ...nextTypescript,
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "react-hooks/exhaustive-deps": "off",
            "react-hooks/set-state-in-effect": "off",
            "prefer-rest-params": "off",
            "@typescript-eslint/ban-ts-comment": "off",
            "@typescript-eslint/no-require-imports": "off",
        },
    },
]

export default config
