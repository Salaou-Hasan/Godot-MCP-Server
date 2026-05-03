@tool
extends EditorPlugin

const MCP_SERVER_DIR = "user://mcp_server"
var _cached_config_path = ""

func _enter_tree():
    _ensure_server_dir()
    _copy_server_files()
    _run_npm_install_automated()
    _update_claude_config()
    print("MCP Manager: Setup complete. Restart Claude Desktop.")

func _ensure_server_dir():
    var server_dir = ProjectSettings.globalize_path(MCP_SERVER_DIR)
    if not DirAccess.dir_exists_absolute(server_dir):
        var root_dir = DirAccess.open("user://")
        if root_dir:
            root_dir.make_dir_recursive("mcp_server")
        else:
            print("MCP Manager: Failed to create server directory.")

func _copy_server_files():
    var plugin_dir = get_script().get_path().get_base_dir()
    var server_dir = ProjectSettings.globalize_path(MCP_SERVER_DIR)
    for file_name in ["index.js", "package.json"]:
        var src = plugin_dir + "/" + file_name
        var dst = server_dir + "/" + file_name
        if FileAccess.file_exists(src) and not FileAccess.file_exists(dst):
            var src_f = FileAccess.open(src, FileAccess.READ)
            var dst_f = FileAccess.open(dst, FileAccess.WRITE)
            if src_f and dst_f:
                dst_f.store_buffer(src_f.get_buffer(src_f.get_length()))
                src_f.close()
                dst_f.close()
                print("MCP Manager: Copied ", file_name)

func _run_npm_install_automated():
    var server_dir = ProjectSettings.globalize_path(MCP_SERVER_DIR)
    var node_modules = server_dir + "/node_modules"
    if DirAccess.dir_exists_absolute(node_modules):
        print("MCP Manager: Dependencies already installed.")
        return

    print("MCP Manager: Running 'npm install'...")
    var bat_path = server_dir + "/install.bat"
    var bat_content = '@echo off\r\n'
    bat_content += 'cd /d "' + server_dir + '"\r\n'
    bat_content += 'npm install\r\n'
    bat_content += 'echo EXIT_CODE: %errorlevel%\r\n'

    var bat_file = FileAccess.open(bat_path, FileAccess.WRITE)
    if not bat_file:
        print("MCP Manager: Failed to create batch file.")
        return
    bat_file.store_string(bat_content)
    bat_file.close()

    var output = []
    var exit_code = OS.execute("cmd.exe", ["/c", bat_path], output, true, false)
    DirAccess.remove_absolute(bat_path)

    if DirAccess.dir_exists_absolute(node_modules):
        print("MCP Manager: npm install completed.")
    else:
        print("MCP Manager: npm install failed. Ensure Node.js is in PATH.")
        print("Output: ", output)

# -------------------- Config crawler --------------------
func _find_claude_config_path() -> String:
    # Return cached path if already found
    if _cached_config_path != "" and FileAccess.file_exists(_cached_config_path):
        return _cached_config_path

    # 1. Quick check of known standard locations
    var known_paths = _get_known_config_paths()
    for p in known_paths:
        if FileAccess.file_exists(p):
            _cached_config_path = p
            return p

    # 2. Use system search (crawler) – Windows only, but safe on other OS
    var os = OS.get_name()
    if os == "Windows":
        # Use 'where' command to find the file (fast recursive search)
        var output = []
        var exit_code = OS.execute("where", ["/R", OS.get_environment("USERPROFILE"), "claude_desktop_config.json"], output, true, false)
        if exit_code == 0 and output.size() > 0:
            # Output may have multiple lines; pick the first one (remove trailing newline)
            var found = output[0].strip_edges()
            if FileAccess.file_exists(found):
                _cached_config_path = found
                return found
    elif os == "macOS" or os == "Linux":
        # Use 'find' command (limit depth to avoid long search)
        var home = OS.get_environment("HOME")
        var output = []
        var exit_code = OS.execute("find", [home, "-name", "claude_desktop_config.json", "-maxdepth", "5", "-type", "f"], output, true, false)
        if exit_code == 0 and output.size() > 0:
            var found = output[0].strip_edges()
            if FileAccess.file_exists(found):
                _cached_config_path = found
                return found

    print("MCP Manager: Could not locate claude_desktop_config.json automatically.")
    return ""

func _get_known_config_paths() -> PackedStringArray:
    var os = OS.get_name()
    var paths = PackedStringArray()
    if os == "Windows":
        var appdata = OS.get_environment("APPDATA")
        var localappdata = OS.get_environment("LOCALAPPDATA")
        paths.append(appdata + "/Claude/claude_desktop_config.json")
        paths.append(localappdata + "/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json")
    elif os == "macOS":
        var home = OS.get_environment("HOME")
        paths.append(home + "/Library/Application Support/Claude/claude_desktop_config.json")
    elif os == "Linux":
        var home = OS.get_environment("HOME")
        paths.append(home + "/.config/Claude/claude_desktop_config.json")
    return paths

# -------------------- Update config (overwrites entry) --------------------
func _update_claude_config():
    var config_path = _find_claude_config_path()
    if config_path.is_empty():
        print("MCP Manager: Claude config file not found. Please ensure Claude Desktop is installed and has been launched at least once.")
        return

    # Read existing config
    var config = {}
    if FileAccess.file_exists(config_path):
        var f = FileAccess.open(config_path, FileAccess.READ)
        var json_str = f.get_as_text()
        f.close()
        var json = JSON.new()
        if json.parse(json_str) == OK:
            config = json.get_data()

    # Ensure mcpServers object
    if not config.has("mcpServers"):
        config["mcpServers"] = {}

    # Overwrite (or add) our server entry
    config["mcpServers"]["godot-project-agent"] = {
        "command": "node",
        "args": [ProjectSettings.globalize_path(MCP_SERVER_DIR) + "/index.js"],
        "env": {
            "GODOT_PROJECT_ROOT": ProjectSettings.globalize_path("res://"),
            "GODOT_EXECUTABLE": OS.get_executable_path()
        }
    }

    # Write back
    var f = FileAccess.open(config_path, FileAccess.WRITE)
    if f:
        f.store_string(JSON.stringify(config, "\t"))
        f.close()
        print("MCP Manager: Updated Claude config at: ", config_path)
    else:
        print("MCP Manager: Failed to write config file. Check permissions.")

# -------------------- Cleanup --------------------
func _exit_tree():
    # Nothing to clean, but you could kill node process if needed
    pass