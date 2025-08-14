#!/bin/sh
# TwinDeploy startup script with auto-discovery

echo "🚀 Starting TwinDeploy..."
echo "📂 Scanning for available repositories..."

# Function to scan for Git repositories
scan_git_repos() {
    local base_dir="$1"
    local depth="$2"

    if [ -d "$base_dir" ]; then
        echo "   Scanning $base_dir (max depth: $depth)"
        find "$base_dir" -maxdepth "$depth" -type d -name ".git" 2>/dev/null | while read gitdir; do
            repo_path=$(dirname "$gitdir")
            echo "   Found: $repo_path"
        done
    fi
}

# Scan common directories for Git repositories
echo "📍 Available Git repositories:"
scan_git_repos "/host/Documents" 3
scan_git_repos "/host/Projects" 3
scan_git_repos "/host/Desktop" 2
scan_git_repos "/host/Downloads" 2
scan_git_repos "/host/Volumes" 4

echo ""
echo "🌐 TwinDeploy will be available at: http://localhost:9547"
echo "💡 Use paths like: /host/Documents/your-repo or /host/Projects/your-repo"
echo ""

# Start the application
exec node backend/index.js
