-- One shared row bounds fresh anonymous lookups across callers and Cloudflare locations.
CREATE TABLE public_search_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_start INTEGER NOT NULL,
  requests INTEGER NOT NULL
);
