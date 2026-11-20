import { NextRequest } from "next/server"
import { handleSearch, searchLabs } from "../utility"

export async function GET(request: NextRequest) {
    return handleSearch(request, searchLabs)
}
