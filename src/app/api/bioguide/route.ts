import { NextRequest } from "next/server"
import { handleSearch } from "../utility"

export async function GET(request: NextRequest) {
    return handleSearch(request, {
        index: "person",
        semanticField: "profileText_semantic",
        nameFields: [
            "givenName",
            "middleName",
            "familyName",
            "unaccentedGivenName",
            "unaccentedMiddleName",
            "unaccentedFamilyName",
            "bioDisplayName",
        ],
        lexicalFields: [
            "familyName",
            "givenName",
            "unaccentedMiddleName",
            "unaccentedGivenName",
            "unaccentedFamilyName",
            "relationship.relatedTo.unaccentedGivenName",
            "relationship.relatedTo.unaccentedFamilyName",
            "bioDisplayName",
            "profileText",
        ],
    })
}
