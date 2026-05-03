#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { diffLines } from "diff";
import AdmZip from "adm-zip";

const execAsync = promisify(exec);

const PROJECT_ROOT = process.env.GODOT_PROJECT_ROOT;
if (!PROJECT_ROOT) {
  console.error("ERROR: GODOT_PROJECT_ROOT environment variable not set");
  process.exit(1);
}

const GODOT_EXECUTABLE = process.env.GODOT_EXECUTABLE || "C:/Program Files/Godot/Godot_v4.2.1_win64.exe";

// ---------- Pending edits store ----------
let pendingEdits = new Map();
let nextEditId = 1;

// ---------- Helper functions ----------
function safeResolve(relativePath) {
  const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  const normalize = (p) => path.normalize(p).toLowerCase().replace(/\\/g, '/');
  const normRoot = normalize(PROJECT_ROOT);
  const normAbs = normalize(absolutePath);
  if (!normAbs.startsWith(normRoot)) {
    throw new Error(`Access denied: ${relativePath} outside project root`);
  }
  return absolutePath;
}

async function listAllFiles() {
  const patterns = ["**/*.gd", "**/*.tscn", "**/*.godot", "**/project.godot", "**/*.json", "**/*.cfg", "**/*.md", "**/*.txt", "**/*.glsl", "**/*.gdshader"];
  const ignore = ["**/.git/**", "**/.godot/**", "**/addons/**", "**/export_presets.cfg", "**/.import/**"];
  const files = await glob(patterns, { cwd: PROJECT_ROOT, ignore, absolute: false });
  return files.sort();
}

async function readFileContent(relativePath) {
  const fullPath = safeResolve(relativePath);
  return await fs.readFile(fullPath, "utf-8");
}

async function applyEditDirect(relativePath, oldText, newText) {
  const fullPath = safeResolve(relativePath);
  let content = await fs.readFile(fullPath, "utf-8");
  if (!content.includes(oldText)) throw new Error(`Text not found in ${relativePath}`);
  const newContent = content.replaceAll(oldText, newText);
  await fs.writeFile(fullPath, newContent, "utf-8");
  return `✅ Applied edit to ${relativePath}`;
}

async function createFile(relativePath, content = "") {
  const fullPath = safeResolve(relativePath);
  const parentDir = path.dirname(fullPath);
  await fs.mkdir(parentDir, { recursive: true });
  if (await fs.access(fullPath).then(() => true).catch(() => false)) {
    throw new Error(`File already exists: ${relativePath}`);
  }
  await fs.writeFile(fullPath, content, "utf-8");
  return `✅ Created file: ${relativePath}`;
}

async function deleteFile(relativePath, confirm = false) {
  if (!confirm) throw new Error("Must set confirm=true to delete files");
  const fullPath = safeResolve(relativePath);
  await fs.rm(fullPath, { force: true });
  return `✅ Deleted: ${relativePath}`;
}

async function renameFile(oldPath, newPath) {
  const fullOld = safeResolve(oldPath);
  const fullNew = safeResolve(newPath);
  await fs.mkdir(path.dirname(fullNew), { recursive: true });
  await fs.rename(fullOld, fullNew);
  return `✅ Moved/renamed: ${oldPath} → ${newPath}`;
}

async function duplicateFile(sourcePath, destPath, confirm = false) {
  if (!confirm) throw new Error("Must set confirm=true to duplicate files");
  const fullSrc = safeResolve(sourcePath);
  const fullDst = safeResolve(destPath);
  await fs.mkdir(path.dirname(fullDst), { recursive: true });
  await fs.copyFile(fullSrc, fullDst);
  return `✅ Copied ${sourcePath} → ${destPath}`;
}

async function createDirectory(dirPath) {
  const fullPath = safeResolve(dirPath);
  await fs.mkdir(fullPath, { recursive: true });
  return `✅ Created directory: ${dirPath}`;
}

async function listDirectory(dirPath = "") {
  const fullPath = safeResolve(dirPath);
  let entries;
  try {
    entries = await fs.readdir(fullPath, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read directory: ${dirPath} – ${err.message}`);
  }
  const list = entries.map(entry => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file"
  }));
  if (list.length === 0) return `Directory ${dirPath || "."} is empty.`;
  let output = `📁 Contents of ${dirPath || "."}:\n`;
  for (const item of list) {
    output += `  ${item.type === "directory" ? "📂" : "📄"} ${item.name}\n`;
  }
  return output;
}

async function createScene(scenePath, rootType = "Node2D", rootName = "Root") {
  const template = `[gd_scene load_steps=0 format=3]\n\n[node name="${rootName}" type="${rootType}"]\n`;
  return await createFile(scenePath, template);
}

async function createScript(scriptPath, content = "extends Node\n\nfunc _ready():\n\tpass\n") {
  return await createFile(scriptPath, content);
}

async function listNodes(tscnPath) {
  const content = await readFileContent(tscnPath);
  const regex = /\[node name="([^"]+)" type="([^"]+)"/g;
  const nodes = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    nodes.push({ name: match[1], type: match[2] });
  }
  if (!nodes.length) return `No nodes found in ${tscnPath}`;
  return `🌿 Nodes in ${tscnPath}:\n` + nodes.map(n => `- ${n.name} (${n.type})`).join("\n");
}

async function renameNodeInScene(scenePath, oldNodeName, newNodeName, confirm = false) {
  if (!confirm) throw new Error("Must set confirm=true to rename nodes");
  const fullPath = safeResolve(scenePath);
  let content = await fs.readFile(fullPath, "utf-8");
  const nodeDeclRegex = new RegExp(`(\\[node name=")${oldNodeName}(")`, 'g');
  if (!nodeDeclRegex.test(content)) {
    throw new Error(`Node "${oldNodeName}" not found in scene ${scenePath}`);
  }
  content = content.replace(nodeDeclRegex, `$1${newNodeName}$2`);
  const pathRefRegex = new RegExp(`(node_path="[^"]*)${oldNodeName}([^"]*")`, 'g');
  content = content.replace(pathRefRegex, `$1${newNodeName}$2`);
  await fs.writeFile(fullPath, content, "utf-8");
  return `✅ Renamed node "${oldNodeName}" → "${newNodeName}" in ${scenePath}`;
}

async function getSceneDependencies(scenePath) {
  const content = await readFileContent(scenePath);
  const extResourceRegex = /ext_resource path="([^"]+)"/g;
  const resources = new Set();
  let match;
  while ((match = extResourceRegex.exec(content)) !== null) {
    resources.add(match[1]);
  }
  const embeddedScriptRegex = /script = "([^"]+\.gd)"/g;
  while ((match = embeddedScriptRegex.exec(content)) !== null) {
    resources.add(match[1]);
  }
  if (resources.size === 0) return `No external dependencies found in ${scenePath}`;
  return `📦 Dependencies for ${scenePath}:\n` + Array.from(resources).map(r => `- ${r}`).join("\n");
}

async function searchInFiles(pattern, extension = null) {
  const files = await listAllFiles();
  let results = [];
  const regex = new RegExp(pattern, 'i');
  for (const file of files) {
    if (extension && !file.endsWith(extension)) continue;
    try {
      const content = await readFileContent(file);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({ file, line: i + 1, text: lines[i].trim().substring(0, 200) });
        }
      }
    } catch (e) { /* ignore binary */ }
  }
  if (results.length === 0) return `No matches for pattern "${pattern}"`;
  let output = `🔍 Found ${results.length} matches for "${pattern}":\n`;
  for (const r of results.slice(0, 50)) {
    output += `${r.file}:${r.line}  ${r.text}\n`;
  }
  if (results.length > 50) output += `... and ${results.length - 50} more.`;
  return output;
}

async function runGameWithTimeout(timeoutSeconds = 3) {
  let mainScene = "";
  try {
    const config = await fs.readFile(path.join(PROJECT_ROOT, "project.godot"), "utf-8");
    const sceneMatch = config.match(/^application\/run\/main_scene="([^"]+)"/m);
    if (sceneMatch) mainScene = sceneMatch[1];
    else throw new Error("No main scene defined in project.godot");
  } catch (e) {
    return `❌ Could not determine main scene: ${e.message}`;
  }
  const fullScenePath = safeResolve(mainScene);
  const args = ["--headless", "--path", PROJECT_ROOT, "--quit-after", timeoutSeconds.toString(), fullScenePath];
  return new Promise((resolve) => {
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const proc = spawn(GODOT_EXECUTABLE, args);
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, (timeoutSeconds + 2) * 1000);
    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      let output = `🎮 Game ran for ${timeoutSeconds}s (exit code ${code}).\n`;
      if (stdout.trim()) output += `\n📢 STDOUT:\n${stdout.slice(0, 2000)}`;
      if (stderr.trim()) output += `\n⚠️ ERRORS/STDERR:\n${stderr.slice(0, 4000)}`;
      if (!stdout.trim() && !stderr.trim()) output += "No console output (silent run).";
      if (code !== 0 && !timedOut) output += `\n❌ Game exited with error code ${code}.`;
      resolve(output.slice(0, 8000));
    });
    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve(`❌ Failed to start Godot: ${err.message}`);
    });
  });
}

async function testProject() {
  try {
    const { stderr } = await execAsync(`"${GODOT_EXECUTABLE}" --headless --path "${PROJECT_ROOT}" --quit`, { timeout: 30000 });
    if (stderr) return `⚠️ Compilation warnings/errors:\n${stderr}`;
    return `✅ Project compiled successfully.`;
  } catch (error) {
    let errorMsg = error.stderr || error.message;
    return `❌ Compilation errors:\n${errorMsg}`;
  }
}

async function projectSummary() {
  const files = await listAllFiles();
  const scripts = files.filter(f => f.endsWith(".gd"));
  const scenes = files.filter(f => f.endsWith(".tscn"));
  let projectName = "Unknown", mainScene = "Unknown";
  try {
    const config = await fs.readFile(path.join(PROJECT_ROOT, "project.godot"), "utf-8");
    const nameMatch = config.match(/^config\/name="([^"]+)"/m);
    if (nameMatch) projectName = nameMatch[1];
    const sceneMatch = config.match(/^application\/run\/main_scene="([^"]+)"/m);
    if (sceneMatch) mainScene = sceneMatch[1];
  } catch(e) {}
  let summary = `📁 **Godot Project**\n📍 ${PROJECT_ROOT}\n🎮 ${projectName}\n🎬 ${mainScene}\n\n📄 ${scripts.length} scripts, ${scenes.length} scenes`;
  if (scripts.length) summary += `\n\n📝 Scripts:\n${scripts.slice(0,10).map(s=>`- ${s}`).join("\n")}`;
  if (scenes.length) summary += `\n\n🎭 Scenes:\n${scenes.slice(0,10).map(s=>`- ${s}`).join("\n")}`;
  return summary;
}

// ---------- Install Addon ----------
async function installAddon(addonName, confirm = false) {
  if (!confirm) {
    throw new Error("Safety: Set confirm=true to install an addon. This will download and extract third-party code.");
  }

  // Search the Asset Library
  const searchUrl = `https://godotengine.org/asset-library/api/asset?filter=${encodeURIComponent(addonName)}&category=all&support=official&limit=5`;
  let response;
  try {
    response = await fetch(searchUrl);
  } catch (err) {
    throw new Error(`Failed to contact Asset Library: ${err.message}`);
  }
  if (!response.ok) throw new Error(`Asset Library returned ${response.status}`);
  const data = await response.json();
  if (!data.result || data.result.length === 0) {
    throw new Error(`No addon found matching "${addonName}"`);
  }
  const asset = data.result[0];
  const assetId = asset.asset_id;
  const title = asset.title;
  const downloadUrl = asset.download_url;

  // Download ZIP
  const zipResponse = await fetch(downloadUrl);
  if (!zipResponse.ok) throw new Error(`Failed to download addon: ${zipResponse.status}`);
  const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());

  // Extract to addons/ folder
  const addonsDir = safeResolve("addons");
  await fs.mkdir(addonsDir, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  const extractTarget = path.join(addonsDir, title);
  zip.extractAllTo(extractTarget, true);

  // Enable the plugin in project.godot
  const projectConfigPath = safeResolve("project.godot");
  let configContent = await fs.readFile(projectConfigPath, "utf-8");
  const pluginSection = "[editor_plugins]";
  const pluginEntry = `  ${title} = true`;

  if (configContent.includes(pluginSection)) {
    if (!configContent.includes(`${pluginEntry}\n`)) {
      configContent = configContent.replace(pluginSection, `${pluginSection}\n${pluginEntry}`);
    }
  } else {
    configContent += `\n${pluginSection}\n${pluginEntry}\n`;
  }
  await fs.writeFile(projectConfigPath, configContent, "utf-8");

  return `✅ Installed addon "${title}" (ID: ${assetId}) to 'addons/${title}'. Enabled in project.godot. Restart Godot to activate.`;
}

// ---------- Approval workflow ----------
async function previewEdit(relativePath, oldText, newText) {
  const fullPath = safeResolve(relativePath);
  const content = await fs.readFile(fullPath, "utf-8");
  if (!content.includes(oldText)) throw new Error(`Text not found in ${relativePath}`);
  const diff = diffLines(content, content.replaceAll(oldText, newText));
  const diffText = diff.map(part => {
    const prefix = part.added ? '+' : part.removed ? '-' : ' ';
    return part.value.split('\n').map(line => prefix + line).join('\n');
  }).join('\n');
  const editId = nextEditId++;
  pendingEdits.set(editId, { relativePath, oldText, newText, preview: diffText });
  return `📝 **Pending edit #${editId}**\nFile: ${relativePath}\n\n\`\`\`diff\n${diffText}\n\`\`\`\nUse \`confirm_edit\` with id ${editId} to apply, or \`confirm_edit\` with apply=false to discard.`;
}

async function listPendingEdits() {
  if (pendingEdits.size === 0) return "No pending edits.";
  let result = `Pending edits (${pendingEdits.size}):\n`;
  for (let [id, edit] of pendingEdits.entries()) {
    result += `#${id}: ${edit.relativePath}\n`;
  }
  return result;
}

async function confirmEdit(editId, apply = true) {
  const id = parseInt(editId);
  if (!pendingEdits.has(id)) throw new Error(`Edit ${id} not found.`);
  const edit = pendingEdits.get(id);
  if (apply) {
    await applyEditDirect(edit.relativePath, edit.oldText, edit.newText);
    pendingEdits.delete(id);
    return `✅ Applied edit #${id} (${edit.relativePath})`;
  } else {
    pendingEdits.delete(id);
    return `❌ Discarded edit #${id}.`;
  }
}

// ---------- MCP server ----------
const server = new Server({ name: "godot-project-agent", version: "6.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // File & directory tools
    { name: "list_files", description: "List all project files (flat)", inputSchema: { type: "object", properties: {} } },
    { name: "list_directory", description: "List files and subfolders inside a directory", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "create_directory", description: "Create a new folder", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "create_file", description: "Create a new file (creates parent folders)", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] } },
    { name: "delete_file", description: "Delete a file (confirm=true)", inputSchema: { type: "object", properties: { path: { type: "string" }, confirm: { type: "boolean" } }, required: ["path","confirm"] } },
    { name: "rename_file", description: "Rename or move a file (creates parent folders)", inputSchema: { type: "object", properties: { old_path: { type: "string" }, new_path: { type: "string" } }, required: ["old_path","new_path"] } },
    { name: "duplicate_file", description: "Copy a file (confirm=true)", inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" }, confirm: { type: "boolean" } }, required: ["source","destination","confirm"] } },
    // Godot-specific
    { name: "create_scene", description: "Create a new Godot scene (.tscn)", inputSchema: { type: "object", properties: { path: { type: "string" }, root_type: { type: "string" }, root_name: { type: "string" } }, required: ["path"] } },
    { name: "create_script", description: "Create a new GDScript", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] } },
    { name: "list_nodes", description: "List nodes inside a .tscn", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "rename_node_in_scene", description: "Rename a node in a scene file (confirm=true)", inputSchema: { type: "object", properties: { scene_path: { type: "string" }, old_name: { type: "string" }, new_name: { type: "string" }, confirm: { type: "boolean" } }, required: ["scene_path","old_name","new_name","confirm"] } },
    { name: "get_scene_dependencies", description: "List resources used by a scene", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "search_in_files", description: "Grep for pattern in project files", inputSchema: { type: "object", properties: { pattern: { type: "string" }, extension: { type: "string" } }, required: ["pattern"] } },
    { name: "project_summary", description: "Get project overview", inputSchema: { type: "object", properties: {} } },
    // Testing & execution
    { name: "test_project", description: "Run Godot headless and return compilation errors", inputSchema: { type: "object", properties: {} } },
    { name: "run_game_with_timeout", description: "Run the game headless for n seconds and capture runtime errors", inputSchema: { type: "object", properties: { timeout_seconds: { type: "number" } } } },
    // Addon installer
    { name: "install_addon", description: "Search and install a Godot addon from the Asset Library (requires confirm=true)", inputSchema: { type: "object", properties: { addon_name: { type: "string" }, confirm: { type: "boolean" } }, required: ["addon_name", "confirm"] } },
    // Approval workflow
    { name: "preview_edit", description: "Show diff and create pending edit for approval", inputSchema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path","old_text","new_text"] } },
    { name: "list_pending", description: "List pending edits", inputSchema: { type: "object", properties: {} } },
    { name: "confirm_edit", description: "Apply or discard a pending edit by ID", inputSchema: { type: "object", properties: { edit_id: { type: "number" }, apply: { type: "boolean" } }, required: ["edit_id","apply"] } }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "list_files": return { content: [{ type: "text", text: (await listAllFiles()).join("\n") }] };
      case "list_directory": return { content: [{ type: "text", text: await listDirectory(args.path || "") }] };
      case "create_directory": return { content: [{ type: "text", text: await createDirectory(args.path) }] };
      case "read_file": return { content: [{ type: "text", text: await readFileContent(args.path) }] };
      case "create_file": return { content: [{ type: "text", text: await createFile(args.path, args.content || "") }] };
      case "delete_file": return { content: [{ type: "text", text: await deleteFile(args.path, args.confirm) }] };
      case "rename_file": return { content: [{ type: "text", text: await renameFile(args.old_path, args.new_path) }] };
      case "duplicate_file": return { content: [{ type: "text", text: await duplicateFile(args.source, args.destination, args.confirm) }] };
      case "create_scene": return { content: [{ type: "text", text: await createScene(args.path, args.root_type, args.root_name) }] };
      case "create_script": return { content: [{ type: "text", text: await createScript(args.path, args.content) }] };
      case "list_nodes": return { content: [{ type: "text", text: await listNodes(args.path) }] };
      case "rename_node_in_scene": return { content: [{ type: "text", text: await renameNodeInScene(args.scene_path, args.old_name, args.new_name, args.confirm) }] };
      case "get_scene_dependencies": return { content: [{ type: "text", text: await getSceneDependencies(args.path) }] };
      case "search_in_files": return { content: [{ type: "text", text: await searchInFiles(args.pattern, args.extension) }] };
      case "project_summary": return { content: [{ type: "text", text: await projectSummary() }] };
      case "test_project": return { content: [{ type: "text", text: await testProject() }] };
      case "run_game_with_timeout": return { content: [{ type: "text", text: await runGameWithTimeout(args.timeout_seconds || 3) }] };
      case "install_addon": return { content: [{ type: "text", text: await installAddon(args.addon_name, args.confirm) }] };
      case "preview_edit": return { content: [{ type: "text", text: await previewEdit(args.path, args.old_text, args.new_text) }] };
      case "list_pending": return { content: [{ type: "text", text: await listPendingEdits() }] };
      case "confirm_edit": return { content: [{ type: "text", text: await confirmEdit(args.edit_id, args.apply) }] };
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return { content: [{ type: "text", text: `❌ ${error.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Godot MCP v6 running (with addon installer)");
}
main().catch(console.error);