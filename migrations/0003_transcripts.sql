-- Transcription: sentence-level segments and word-level timings.

CREATE TABLE transcripts (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    video_id      uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    engine        text NOT NULL DEFAULT 'whisperx',
    model         text NOT NULL,                     -- e.g. 'large-v3'
    language      text,
    diarised      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transcripts_video ON transcripts (video_id);

-- Sentence/utterance level. Good for reading, search, and segment selection.
CREATE TABLE transcript_segments (
    id             bigserial PRIMARY KEY,
    transcript_id  uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    idx            int NOT NULL,
    start_s        numeric(10,3) NOT NULL,
    end_s          numeric(10,3) NOT NULL,
    speaker        text,
    text           text NOT NULL,
    tsv            tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

CREATE INDEX idx_segments_transcript ON transcript_segments (transcript_id, start_s);
CREATE INDEX idx_segments_tsv ON transcript_segments USING gin (tsv);

-- Word level. Drives clip boundaries and karaoke subtitles.
CREATE TABLE transcript_words (
    id             bigserial PRIMARY KEY,
    transcript_id  uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    segment_id     bigint REFERENCES transcript_segments(id) ON DELETE CASCADE,
    idx            int NOT NULL,
    word           text NOT NULL,
    start_s        numeric(10,3),
    end_s          numeric(10,3),
    speaker        text,
    confidence     numeric(5,4)
);

CREATE INDEX idx_words_transcript_time ON transcript_words (transcript_id, start_s);
