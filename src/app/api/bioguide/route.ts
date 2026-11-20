import { NextRequest } from "next/server"
import { bioGuideSearch, extractBioGuideResults, handleSearch } from "../utility"

export async function GET(request: NextRequest) {
    return handleSearch(request, bioGuideSearch, extractBioGuideResults)
}
