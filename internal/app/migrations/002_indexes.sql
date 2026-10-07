-- Admin work is date-oriented; the venue-leading slot index cannot cover it.
CREATE INDEX mediations_date_start ON mediations(date,start);
CREATE INDEX mediations_pending_export ON mediations(date) WHERE exported_at IS NULL;
CREATE INDEX news_published_date ON news(published,publication_date DESC);
