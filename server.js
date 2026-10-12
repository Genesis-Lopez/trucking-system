/**
 * Trucking Fleet GPS Tracking, ETA & Billing System
 * Full backend implementing the real dispatch workflow:
 *
 *   1. Office dispatches a truck (no destination yet)
 *   2. Truck's GPS starts logging immediately (trip_id = NULL)
 *   3. Driver calls in the destination -> trip created, recent GPS backfilled
 *   4. ETA recalculated on every GPS ping while trip is in_progress
 *   5. Truck marked "delivered" once shipment is dropped off
 *   6. Truck returns with waybill -> trip finalized, awaiting_billing
 *   7. Admin generates the invoice from the finalized trip
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // frontend lives in /public

const RATE_PER_KM = 25; // pesos per km, adjust as needed

// ---------- Helpers ----------

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateETA(currentLat, currentLng, speedKmph, destLat, destLng) {
  const distanceKm = haversineDistanceKm(currentLat, currentLng, destLat, destLng);
  const effectiveSpeed = speedKmph > 5 ? speedKmph : 40; // fallback avg speed if stopped/slow
  const hoursRemaining = distanceKm / effectiveSpeed;
  return new Date(Date.now() + hoursRemaining * 3600 * 1000);
}

async function getTotalTripDistance(tripId) {
  const logs = await pool.query(
    `SELECT latitude, longitude FROM gps_logs WHERE trip_id = $1 ORDER BY recorded_at ASC`,
    [tripId]
  );
  let total = 0;
  for (let i = 1; i < logs.rows.length; i++) {
    const a = logs.rows[i - 1];
    const b = logs.rows[i];
    total += haversineDistanceKm(a.latitude, a.longitude, b.latitude, b.longitude);
  }
  return total;
}

// ---------- Health check ----------

app.get('/api/test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ ok: true, time: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Stage 1: Dispatch (no destination yet) ----------

app.post('/api/dispatch', async (req, res) => {
  const { truck_id } = req.body;
  try {
    await pool.query(
      `UPDATE trucks SET status = 'dispatched', dispatched_at = NOW() WHERE id = $1`,
      [truck_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Stage 2: GPS ingest (works with or without a trip yet) ----------

app.post('/api/gps', async (req, res) => {
  const { device_id, lat, lng, speed, timestamp } = req.body;
  try {
    const truckResult = await pool.query('SELECT id FROM trucks WHERE device_id = $1', [device_id]);
    if (!truckResult.rows.length) return res.status(404).json({ error: 'Unknown device' });
    const truckId = truckResult.rows[0].id;

    // Attach to the truck's active trip if one exists; otherwise trip_id stays NULL
    const tripResult = await pool.query(
      `SELECT * FROM trips WHERE truck_id = $1 AND status = 'in_progress' LIMIT 1`,
      [truckId]
    );
    const trip = tripResult.rows[0] || null;

    await pool.query(
      `INSERT INTO gps_logs (truck_id, trip_id, latitude, longitude, speed_kmph, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [truckId, trip?.id ?? null, lat, lng, speed, timestamp || new Date()]
    );

    if (trip) {
      const eta = calculateETA(lat, lng, speed, trip.destination_lat, trip.destination_lng);
      await pool.query(`UPDATE trips SET estimated_arrival = $1 WHERE id = $2`, [eta, trip.id]);
    }

    res.status(200).json({ ok: true, trip_id: trip?.id ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Stage 3: Driver calls in destination -> create trip mid-flight ----------

app.post('/api/trips', async (req, res) => {
  const { truck_id, client_id, destination_lat, destination_lng, allowance_amount } = req.body;
  try {
    const tripResult = await pool.query(
      `INSERT INTO trips (truck_id, client_id, destination_lat, destination_lng, allowance_amount, status, started_at)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', NOW()) RETURNING id`,
      [truck_id, client_id, destination_lat, destination_lng, allowance_amount || null]
    );
    const tripId = tripResult.rows[0].id;

    // Backfill this truck's untagged GPS pings onto the new trip, anchored to
    // the moment this truck was last dispatched (a real event) rather than a
    // guessed time window - this stays correct even if loading takes hours,
    // and won't misattribute pings from an earlier same-day trip.
    const truckRow = await pool.query('SELECT dispatched_at FROM trucks WHERE id = $1', [truck_id]);
    const dispatchedAt = truckRow.rows[0]?.dispatched_at || new Date(0);

    await pool.query(
      `UPDATE gps_logs SET trip_id = $1
       WHERE truck_id = $2 AND trip_id IS NULL AND recorded_at >= $3`,
      [tripId, truck_id, dispatchedAt]
    );

    await pool.query(`UPDATE trucks SET status = 'in_transit' WHERE id = $1`, [truck_id]);

    res.json({ ok: true, trip_id: tripId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// NOTE: must be defined BEFORE '/api/trips/:id' or Express treats 'awaiting-billing' as an id
app.get('/api/trips/awaiting-billing', async (req, res) => {
  try {
    const trips = await pool.query(
      `SELECT * FROM trips WHERE status = 'awaiting_billing' ORDER BY finalized_at ASC`
    );
    res.json(trips.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/trips/:id', async (req, res) => {
  try {
    const trip = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (!trip.rows.length) return res.status(404).json({ error: 'Trip not found' });
    res.json(trip.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Stage 4: Shipment delivered (before paperwork is back) ----------

app.patch('/api/trips/:id/delivered', async (req, res) => {
  try {
    await pool.query(
      `UPDATE trips SET status = 'delivered', delivered_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Stage 5: Truck returns with waybill -> finalize trip ----------

app.patch('/api/trips/:id/waybill', async (req, res) => {
  const { waybill_number, stops } = req.body;
  try {
    await pool.query(
      `UPDATE trips SET waybill_number = $1, status = 'awaiting_billing', finalized_at = NOW()
       WHERE id = $2`,
      [waybill_number, req.params.id]
    );

    if (Array.isArray(stops) && stops.length) {
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        await pool.query(
          `INSERT INTO trip_stops (trip_id, client_id, drop_type, notes, sequence_number)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, s.client_id, s.drop_type || null, s.notes || null, i + 1]
        );
      }
    }

    await pool.query(
      `UPDATE trucks SET status = 'awaiting_billing'
       WHERE id = (SELECT truck_id FROM trips WHERE id = $1)`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/trips/:id/stops', async (req, res) => {
  try {
    const stops = await pool.query(
      `SELECT ts.*, c.company_name FROM trip_stops ts
       JOIN clients c ON c.id = ts.client_id
       WHERE ts.trip_id = $1 ORDER BY ts.sequence_number ASC`,
      [req.params.id]
    );
    res.json(stops.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Stage 6: Generate invoice from a finalized trip ----------

app.post('/api/trips/:id/invoice', async (req, res) => {
  try {
    const tripResult = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (!tripResult.rows.length) return res.status(404).json({ error: 'Trip not found' });
    const trip = tripResult.rows[0];

    if (!trip.waybill_number) {
      return res.status(400).json({ error: 'Cannot invoice — waybill not submitted yet' });
    }

    const distanceKm = await getTotalTripDistance(req.params.id);
    const amount = distanceKm * RATE_PER_KM;

    await pool.query(
      `UPDATE trips SET status = 'completed', distance_km = $1 WHERE id = $2`,
      [distanceKm, req.params.id]
    );

    const invoice = await pool.query(
      `INSERT INTO invoices (client_id, trip_id, amount, due_at)
       VALUES ($1, $2, $3, NOW() + interval '30 days') RETURNING id`,
      [trip.client_id, req.params.id, amount]
    );

    await pool.query(`UPDATE trucks SET status = 'idle' WHERE id = $1`, [trip.truck_id]);

    res.json({ ok: true, invoice_id: invoice.rows[0].id, amount, distance_km: distanceKm });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Invoices ----------

app.get('/api/clients/:id/invoices', async (req, res) => {
  try {
    const invoices = await pool.query(
      `SELECT * FROM invoices WHERE client_id = $1 ORDER BY issued_at DESC`,
      [req.params.id]
    );
    res.json(invoices.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/invoices/:id/pay', async (req, res) => {
  try {
    await pool.query(
      `UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Trucks ----------

app.get('/api/trucks', async (req, res) => {
  try {
    const trucks = await pool.query('SELECT * FROM trucks ORDER BY id');
    res.json(trucks.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/trucks/:id', async (req, res) => {
  try {
    const truck = await pool.query('SELECT * FROM trucks WHERE id = $1', [req.params.id]);
    if (!truck.rows.length) return res.status(404).json({ error: 'Truck not found' });

    const latest = await pool.query(
      `SELECT * FROM gps_logs WHERE truck_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [req.params.id]
    );

    res.json({ ...truck.rows[0], latest_position: latest.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/trucks/:id/history', async (req, res) => {
  try {
    const history = await pool.query(
      `SELECT latitude, longitude, speed_kmph, recorded_at FROM gps_logs
       WHERE truck_id = $1 ORDER BY recorded_at ASC`,
      [req.params.id]
    );
    res.json(history.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Setup helpers: add trucks and clients ----------

app.post('/api/trucks', async (req, res) => {
  const { plate_number, device_id } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO trucks (plate_number, device_id) VALUES ($1, $2) RETURNING *`,
      [plate_number, device_id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/clients', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM clients ORDER BY company_name');
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  const { company_name, contact_email, contact_phone, address } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO clients (company_name, contact_email, contact_phone, address)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [company_name, contact_email || null, contact_phone || null, address || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Start server ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));