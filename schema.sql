-- FleetTrack database schema (Supabase / PostgreSQL)
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Order matters because of the foreign keys.

CREATE TABLE drivers (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  license_no  VARCHAR(50),
  phone       VARCHAR(20),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Clients are created automatically the first time a name is typed into a form.
-- lat/lng are filled when an address is geocoded, and reused for ETA on later trips.
CREATE TABLE clients (
  id            SERIAL PRIMARY KEY,
  company_name  VARCHAR(150) UNIQUE NOT NULL,
  contact_email VARCHAR(150),
  contact_phone VARCHAR(20),
  address       TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- The company's rate card: one row per destination area.
CREATE TABLE areas (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(100) NOT NULL,
  zone  VARCHAR(10)  NOT NULL,
  rate  NUMERIC(10,2) NOT NULL
);

CREATE TABLE trucks (
  id            SERIAL PRIMARY KEY,
  plate_number  VARCHAR(20) UNIQUE NOT NULL,
  device_id     VARCHAR(50) UNIQUE NOT NULL,   -- must match DEVICE_ID in the ESP32 firmware
  driver_id     INTEGER REFERENCES drivers(id),
  status        VARCHAR(20) DEFAULT 'idle',    -- idle, dispatched, in_transit, awaiting_billing
  dispatched_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE trips (
  id                  SERIAL PRIMARY KEY,
  truck_id            INTEGER REFERENCES trucks(id),
  client_id           INTEGER REFERENCES clients(id),
  destination_address TEXT,
  destination_lat     DOUBLE PRECISION,        -- optional, only needed for ETA
  destination_lng     DOUBLE PRECISION,
  distance_km         DOUBLE PRECISION,        -- measured from GPS, informational only
  status              VARCHAR(20) DEFAULT 'in_progress', -- in_progress, delivered, awaiting_billing, completed
  allowance_amount    NUMERIC(10,2),
  waybill_number      VARCHAR(50),
  waybill_total       NUMERIC(10,2),           -- sum of all stop rates; this is what gets invoiced
  started_at          TIMESTAMPTZ DEFAULT NOW(),
  delivered_at        TIMESTAMPTZ,
  finalized_at        TIMESTAMPTZ,
  estimated_arrival   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE gps_logs (
  id          SERIAL PRIMARY KEY,
  truck_id    INTEGER REFERENCES trucks(id),
  trip_id     INTEGER REFERENCES trips(id),    -- empty until the driver reports a destination
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  speed_kmph  DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gps_logs_truck_time ON gps_logs (truck_id, recorded_at DESC);

-- One row per stop on the paper waybill.
-- stop_type: main (area-priced), additional (area-priced), extra (flat fee)
CREATE TABLE trip_stops (
  id              SERIAL PRIMARY KEY,
  trip_id         INTEGER REFERENCES trips(id),
  stop_type       VARCHAR(12) DEFAULT 'main',
  client_name     VARCHAR(150),
  address         TEXT,
  area_id         INTEGER REFERENCES areas(id),
  dr_number       VARCHAR(50),
  rate            NUMERIC(10,2) DEFAULT 0,
  waybill_type    VARCHAR(30),                 -- Waybill / Double Waybill
  drop_type       VARCHAR(30),                 -- Haul / Drop
  notes           TEXT,
  sequence_number INTEGER
);

CREATE TABLE invoices (
  id         SERIAL PRIMARY KEY,
  client_id  INTEGER REFERENCES clients(id),
  trip_id    INTEGER REFERENCES trips(id),
  amount     NUMERIC(10,2) NOT NULL,
  status     VARCHAR(20) DEFAULT 'unpaid',     -- unpaid, paid
  issued_at  TIMESTAMPTZ DEFAULT NOW(),
  due_at     TIMESTAMPTZ,
  paid_at    TIMESTAMPTZ
);

-- Sample rate card taken from the design. REPLACE these with the company's real areas and rates.
INSERT INTO areas (name, zone, rate) VALUES
  ('Manila',  'A', 4500.00),
  ('Makati',  'C', 8500.00);