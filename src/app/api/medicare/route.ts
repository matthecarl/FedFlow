import { NextRequest } from "next/server"
import { handleSearch } from "../utility"

export async function GET(request: NextRequest) {
    return handleSearch(request, {
        index: "search-medicare",
        semanticField: "semantic_text",
    })
}
