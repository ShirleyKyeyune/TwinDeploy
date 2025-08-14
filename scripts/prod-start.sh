#!/bin/bash
# TwinDeploy Production Launcher
# Secure mode - requires explicit volume mounting

echo "🏭 Starting TwinDeploy in Production Mode..."
echo "🔒 Secure mode - no automatic directory mounting"

if [ $# -eq 0 ]; then
    echo ""
    echo "Usage: $0 <repo-path-1> [repo-path-2] ..."
    echo ""
    echo "Examples:"
    echo "  $0 /Users/username/my-project"
    echo "  $0 /Users/username/project1 /Users/username/project2"
    echo ""
    echo "Or use docker-compose directly:"
    echo "  docker-compose -f docker-compose.prod.yml up -d"
    exit 1
fi

# Build volume mount arguments
VOLUME_ARGS=""
COUNTER=1
for repo_path in "$@"; do
    if [ ! -d "$repo_path" ]; then
        echo "❌ Directory does not exist: $repo_path"
        exit 1
    fi

    # Convert to absolute path
    abs_path=$(cd "$repo_path" && pwd)
    VOLUME_ARGS="$VOLUME_ARGS -v $abs_path:/host/repo$COUNTER:ro"
    echo "📁 Mounting: $abs_path -> /host/repo$COUNTER"
    COUNTER=$((COUNTER + 1))
done

echo ""
echo "🚀 Starting container with mounted repositories..."

# Stop existing container
docker stop twindeploy 2>/dev/null
docker rm twindeploy 2>/dev/null

# Start with specific mounts
docker run -d \
    --name twindeploy \
    -p 9547:9547 \
    -e NODE_ENV=production \
    $VOLUME_ARGS \
    twindeploy

echo "✅ TwinDeploy started in production mode"
echo "🌐 Access at: http://localhost:9547"
echo "📁 Use these paths in the app:"
COUNTER=1
for repo_path in "$@"; do
    echo "   /host/repo$COUNTER ($(basename "$repo_path"))"
    COUNTER=$((COUNTER + 1))
done
