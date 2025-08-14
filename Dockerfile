# Base stage for building frontend
FROM node:18-alpine AS build-frontend
WORKDIR /app
COPY frontend/package*.json ./frontend/
RUN npm install --prefix frontend
COPY frontend ./frontend
RUN npm run build --prefix frontend

# Base stage for backend
FROM node:18-alpine AS build-backend
WORKDIR /app
COPY backend/package*.json ./backend/
RUN npm install --prefix backend --production
COPY backend ./backend

# Production stage
FROM node:18-alpine
WORKDIR /app

# Install git for repository operations
RUN apk add --no-cache git

# Copy backend
COPY --from=build-backend /app/backend ./backend
# Copy frontend build files
COPY --from=build-frontend /app/frontend/dist ./frontend/dist

# Copy startup script
COPY scripts/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# Expose ports for backend and frontend (optional)
EXPOSE 9547

# Use startup script instead of direct node command
CMD ["/usr/local/bin/start.sh"]
