# Build from the repo root (the worker imports as a package):
#   docker build -f worker/Dockerfile -t airtomic-worker .
# On Railway set the Dockerfile path to worker/Dockerfile with root context.
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/requirements.txt worker/requirements.txt
RUN pip install --no-cache-dir -r worker/requirements.txt

COPY worker worker

CMD ["python", "-m", "worker.main"]
