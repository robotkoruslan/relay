FROM node:22-slim
WORKDIR /app
COPY package*.json ./
# ci, not install: installs exactly what the lockfile pins, so an image build cannot silently
# resolve a different dependency tree than the one that was tested.
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/index.ts"]
