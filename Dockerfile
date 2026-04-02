# Dockerfile for MCP introspection testing (Glama, Smithery, etc.)
# Safari MCP is macOS-only at runtime, but the MCP server starts on any
# platform and responds to introspection requests (tools/list, etc.).
# Actual Safari automation requires macOS + Safari.

FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js safari.js mcp-helpers.js ./

ENTRYPOINT ["node", "index.js"]
