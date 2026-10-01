FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
ENV PORT=8080
ENV CACHE_DIR=/data/cache
# ENV PUBLIC_BASE=https://your-domain.example      <- set this to how the server is reached publicly
# ENV ALLOWED_ORIGIN=https://yourblog.blogspot.com  <- set this to your Blogger origin (or * while testing)
VOLUME ["/data/cache"]
EXPOSE 8080
CMD ["node", "index.js"]
