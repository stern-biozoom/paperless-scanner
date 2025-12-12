# Paperless Scanner

A lightweight web-based scanner bridge for Paperless-ngx — runs as a Docker container.

## Features

- 📄 Web-based scanning interface to trigger scans
- ⚙️ Persistent settings (saved to `config.json`)
- 🔧 Connection testing to verify Paperless-ngx access
- 📜 Real-time logs (server-sent events)
- 🏷️ Configurable default tags for uploads
- 📱 Mobile-friendly UI

## Quick start

```bash
docker pull fakeridoo/paperless-scanner:latest
```

### Run (example)

```bash
docker run --rm -it \
   -p 3000:3000 \
   --device /dev/bus/usb:/dev/bus/usb \
   -v $(pwd)/scans:/tmp \
   -v $(pwd)/config.json:/usr/src/app/config.json:ro \
   --privileged \
   fakeridoo/paperless-scanner:latest
```

## Docker Compose (example)

```yaml
version: '3.8'
services:
   scanner:
      image: fakeridoo/paperless-scanner:latest
      container_name: paperless-scanner
      ports:
         - "3000:3000"
      volumes:
         - ./scans:/tmp
         - ./config.json:/usr/src/app/config.json:ro
      devices:
         - "/dev/bus/usb:/dev/bus/usb"
      network_mode: host
      restart: unless-stopped
      privileged: true
