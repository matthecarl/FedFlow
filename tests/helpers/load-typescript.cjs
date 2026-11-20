/* global require, module, __dirname, console, URL, Buffer, Headers, Request, Response, ReadableStream, TextDecoder, TextEncoder, AbortSignal, performance */
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")

// Execute TypeScript modules with explicit dependencies; unexpected imports/network calls fail.
module.exports = function loadTypeScript(file, { dependencies = {}, env = {}, globals = {} } = {}) {
    const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const context = {
        exports: {},
        require(id) {
            if (!(id in dependencies)) throw new Error(`Unmocked dependency: ${id}`)
            return dependencies[id]
        },
        process: { env },
        console,
        URL,
        Buffer,
        Headers,
        Request,
        Response,
        ReadableStream,
        TextDecoder,
        TextEncoder,
        AbortSignal,
        performance,
        fetch() {
            throw new Error("Unexpected network request")
        },
        ...globals,
    }
    vm.runInNewContext(source, context, { filename: file })
    return context.exports
}
