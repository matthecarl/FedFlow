import type { Parent, Root, RootContent, Text } from "mdast"
import { find } from "linkifyjs"

function linkPlainText(node: Text): RootContent[] {
    const children: RootContent[] = []
    let offset = 0

    for (const { href, start, end, value } of find(node.value, "url", { defaultProtocol: "https" })) {
        // A bare address found inside a scheme like javascript: or ftp:// is
        // part of that address. Leave it alone instead of changing its meaning.
        if (/[\w.+-]:\/{0,2}$/.test(node.value.slice(Math.max(0, start - 4), start))) continue

        let url: URL
        try {
            url = new URL(href)
        } catch {
            continue
        }
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) continue

        if (start > offset) children.push({ type: "text", value: node.value.slice(offset, start) })
        children.push({ type: "link", url: url.href, children: [{ type: "text", value }] })
        offset = end
    }

    if (!children.length) return [node]
    if (offset < node.value.length) children.push({ type: "text", value: node.value.slice(offset) })
    return children
}

function linkChildren(parent: Parent) {
    parent.children = parent.children.flatMap((child) => {
        if (child.type === "text") return linkPlainText(child)
        if ("children" in child && child.type !== "link" && child.type !== "linkReference") linkChildren(child)
        return [child]
    })
}

export function remarkTranscriptLinks() {
    return (tree: Root) => linkChildren(tree)
}
