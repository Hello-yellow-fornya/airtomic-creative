# Build from the repo root (the worker imports as a package):
#   docker build -f worker/Dockerfile -t airtomic-worker .
# On Railway set the Dockerfile path to worker/Dockerfile with root context.
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/requirements.txt worker/requirements.txt
RUN pip install --no-cache-dir -r worker/requirements.txt

COPY worker worker

# Overlay font: Plus Jakarta Sans (OFL, vendored with licence). The variable
# TTF carries the 200-800 weight range; fc-cache registers it for libass.
RUN mkdir -p /usr/share/fonts/truetype/plusjakarta \
    && cp worker/fonts/PlusJakartaSans-Variable.ttf /usr/share/fonts/truetype/plusjakarta/ \
    && fc-cache -f

CMD ["python", "-m", "worker.main"]
