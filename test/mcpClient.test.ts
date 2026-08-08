import assert from "node:assert/strict";
import test from "node:test";
import { exposedMcpToolName, isMcpMutationTool, parseMcpToolAllowlist } from "../src/mcpClient.ts";

test("parses MCP tool allowlists and blocks mutating tools by default", () => {
  assert.deepEqual(parseMcpToolAllowlist("bitable_v1_app_get, bitable_v1_app_table_list"), new Set(["bitable_v1_app_get", "bitable_v1_app_table_list"]));
  assert.equal(parseMcpToolAllowlist(""), undefined);
  assert.equal(isMcpMutationTool("bitable_v1_app_table_field_delete"), true);
  assert.equal(isMcpMutationTool("bitable_v1_app_table_record_search"), false);
  assert.equal(isMcpMutationTool("rename-doc"), true);
  assert.equal(isMcpMutationTool("set-doc-permission"), true);
  assert.equal(isMcpMutationTool("unknown-tool"), true);
  assert.equal(isMcpMutationTool("fetch-doc"), false);
});

test("normalizes remote MCP names and keeps collisions distinct", () => {
  const used = new Map<string, string>();
  const dotted = exposedMcpToolName("bitable.v1.appTableField.delete", used);
  used.set(dotted, "bitable.v1.appTableField.delete");
  const underscored = exposedMcpToolName("bitable_v1_appTableField_delete", used);
  assert.match(dotted, /^[A-Za-z0-9_-]{1,64}$/);
  assert.match(underscored, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(dotted, underscored);
});
