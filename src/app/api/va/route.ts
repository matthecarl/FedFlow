import { NextRequest } from "next/server"
import { handleSearch } from "../utility"

export async function GET(request: NextRequest) {
    return handleSearch(request, {
        index: "search-va",
        semanticField: "semantic_text",
        lexicalFields: ["title", "body_content"],
    })
}
