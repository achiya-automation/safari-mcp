#!/bin/sh
set -eu

token_file="${HOME}/.safari-mcp-bridge-token"
resource_dir="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
resource_file="${resource_dir}/bridge-auth-token"

# A downloadable release must not carry the builder's own token: its users pair instead
# (`npx safari-mcp pair`). scripts/release-app.sh builds with SAFARI_MCP_EMBED_BRIDGE_TOKEN=NO.
if [ "${SAFARI_MCP_EMBED_BRIDGE_TOKEN:-YES}" = "NO" ]; then
  # An earlier local build into the same folder may have left its token there.
  /bin/rm -f "${resource_file}"
  echo "Safari MCP: not embedding a bridge token (SAFARI_MCP_EMBED_BRIDGE_TOKEN=NO); the extension will ask to pair."
  exit 0
fi

if ! [ -s "${token_file}" ] || ! /usr/bin/grep -Eq '^[0-9a-f]{64}$' "${token_file}"; then
  umask 077
  generated_file="${token_file}.$$"
  /usr/bin/openssl rand -hex 32 > "${generated_file}"
  /bin/chmod 600 "${generated_file}"
  /bin/mv -f "${generated_file}" "${token_file}"
fi

if ! /usr/bin/grep -Eq '^[0-9a-f]{64}$' "${token_file}"; then
  echo "Safari MCP bridge token is missing or invalid" >&2
  exit 1
fi

/bin/chmod 600 "${token_file}"

/bin/mkdir -p "${resource_dir}"
/bin/cp "${token_file}" "${resource_file}"
/bin/chmod 600 "${resource_file}"
