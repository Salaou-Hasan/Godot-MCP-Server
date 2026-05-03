# Godot MCP Server – Claude AI Agent for Godot

This MCP (Model Context Protocol) server gives Claude Desktop full control over your Godot project: read/write files, create scenes/scripts, organize folders, run the game headlessly, and automatically fix errors.

## Features

- 📁 **Full file system access** – create, edit, delete, rename files and folders
- 🎮 **Godot‑aware tools** – create `.tscn` scenes, GDScript files, list nodes
- 🧪 **Testing & debugging** – run the game headlessly, capture runtime errors
- ✅ **Approval workflow** – preview edits before applying
- 🔍 **Search & refactor** – grep across files, rename nodes in scenes
- 🗂️ **Project organisation** – manage subfolders, move files
- 🌐 **Claude built‑in web search** – fetch latest Godot documentation

## Prerequisites

- **Node.js** (v18 or later) – [download](https://nodejs.org)
- **Claude Desktop** – latest version
- **Godot 4** – any 4.x version

## Installation (One‑click plugin)

1. Copy the `addons/godot_mcp_manager/` folder into your Godot project.
2. Enable the plugin: **Project → Project Settings → Plugins** → toggle **MCP Manager for Godot** to **On**.
3. The plugin will automatically:
   - Copy the MCP server files to a global folder
   - Run `npm install` (first time only)
   - Update Claude Desktop’s configuration file
4. **Restart Claude Desktop**.
5. Done! Claude can now access your project.

## Switching to another Godot project

- Open the other project.
- Enable the plugin (same steps 2–4 above).  
  The plugin updates Claude’s config to point to the new project.
- Restart Claude Desktop.

## What Claude can do after setup

```text
- "List all files in my project"
- "Create a new scene called Player.tscn with a CharacterBody2D root"
- "Create a script scripts/player.gd with basic movement"
- "Organise my project: create folders scenes/, scripts/, assets/"
- "Run the game for 5 seconds and show me errors"
- "Search for 'velocity' in all GDScript files"
- "Fix the error 'Invalid access to property position'"

## Screenshots

### Enable the plugin in Godot
![Plugin enabled](https://raw.githubusercontent.com/Salaou-Hasan/Godot-MCP-Server/main/images/Plugin_enabled.png)

### Claude Desktop – Available MCP tools
![Claude tools](https://raw.githubusercontent.com/Salaou-Hasan/Godot-MCP-Server/main/images/Tools.png)

### Additional tools – Approval workflow, testing, etc.
![More tools](https://raw.githubusercontent.com/Salaou-Hasan/Godot-MCP-Server/main/images/Also_tools.png)