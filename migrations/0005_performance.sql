-- Ad-level raw counts from Airtomic, rolled up to video level.

CREATE TABLE ad_performance (
    id                 bigserial PRIMARY KEY,
    meta_video_id      text NOT NULL,
    ad_id              text NOT NULL,
    adset_id           text,
    campaign_id        text,
    ad_name            text,
    objective          text,
    date_start         date,
    date_stop          date,
    impressions        bigint,
    reach              bigint,
    video_3s_views     bigint,
    video_15s_views    bigint,
    thruplays          bigint,
    video_p25          bigint,
    video_p50          bigint,
    video_p75          bigint,
    video_p100         bigint,
    link_clicks        bigint,
    spend              numeric(14,4),
    purchases          bigint,
    purchase_value     numeric(14,4),
    currency           text,
    attribution_window text,
    synced_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ad_id, meta_video_id)
);

CREATE INDEX idx_perf_video ON ad_performance (meta_video_id);

-- Roll up to video level. Rates computed here, never imported pre-computed.
CREATE VIEW video_performance AS
SELECT
    meta_video_id,
    count(DISTINCT ad_id)                        AS ad_count,
    sum(spend)                                   AS spend,
    sum(impressions)                             AS impressions,
    sum(video_3s_views)                          AS video_3s_views,
    sum(purchases)                               AS purchases,
    sum(purchase_value)                          AS purchase_value,
    sum(video_3s_views)::numeric
        / nullif(sum(impressions), 0)            AS thumbstop_rate,
    sum(video_15s_views)::numeric
        / nullif(sum(video_3s_views), 0)         AS hold_rate,
    sum(link_clicks)::numeric
        / nullif(sum(impressions), 0)            AS ctr,
    sum(spend) / nullif(sum(purchases), 0)       AS cpa,
    sum(purchase_value) / nullif(sum(spend), 0)  AS roas
FROM ad_performance
GROUP BY meta_video_id;
