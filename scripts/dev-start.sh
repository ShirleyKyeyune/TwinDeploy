#!/bin/bash
# TwinDeploy Development Launcher
# Automatically mounts common directories and starts the container

echo "🔧 Starting TwinDeploy in Development Mode..."
echo "📂 Auto-mounting common directories for Git repository access"

# Stop existing container if running
docker-compose down 2>/dev/null

# Start with auto-mounted directories
docker-compose up -d

echo ""
echo "✅ TwinDeploy is starting up..."
echo "🌐 Access at: http://localhost:9547"
echo "📁 Your repositories are accessible under /host/ paths:"
echo "   - /host/Documents"
echo "   - /host/Projects"
echo "   - /host/Desktop"
echo "   - /host/Downloads"
echo "   - /host/Volumes"
echo ""
echo "💡 Example repo path: /host/Documents/my-project"
echo ""
echo "📋 View logs: docker-compose logs -f"
echo "🛑 Stop: docker-compose down"
