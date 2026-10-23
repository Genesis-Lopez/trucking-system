/**
 * FleetTrack backend (Node.js + Express + PostgreSQL)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db'); // db.js also loads .env

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // dashboard lives in /public

const EXTRA_DROP_FEE = 700;     // pesos, flat fee for an "extra drop"
const FALLBACK_SPEED_KMH = 40;  // used for ETA when the truck is stopped or crawling

// ---------- Helpers ----------

const h = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  });

const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateETA(lat, lng, speedKmph, destLat, destLng) {
  const km = haversineDistanceKm(lat, lng, destLat, destLng);
  const speed = speedKmph > 5 ? speedKmph : FALLBACK_SPEED_KMH;
  return new Date(Date.now() + (km / speed) * 3600 * 1000);
}

async function getTotalTripDistance(tripId) {
  const logs = await pool.query(
    'SELECT latitude, longitude FROM gps_logs WHERE trip_id = $1 ORDER BY recorded_at ASC',
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

async function geocode(address) {
  if (!address) return null;
  try {
    const url =
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ph&q=' +
      encodeURIComponent(address);
    const r = await fetch(url, { headers: { 'User-Agent': 'FleetTrack-thesis/1.0' } });
    const j = await r.json();
    if (Array.isArray(j) && j.length) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
  } catch (e) {
    console.error('geocode failed:', e.message);
  }
  return null;
}

async function getOrCreateClient(name, db = pool) {
  const n = (name || '').trim();
  if (!n) return null;
  const r = await db.query(
    `INSERT INTO clients (company_name) VALUES ($1)
     ON CONFLICT (company_name) DO UPDATE SET company_name = EXCLUDED.company_name
     RETURNING id`,
    [n]
  );
  return r.rows[0].id;
}

const TRIP_SELECT = `
  SELECT tr.*, t.plate_number, c.company_name AS client_name
  FROM trips tr
  JOIN trucks t ON t.id = tr.truck_id
  LEFT JOIN clients c ON c.id = tr.client_id`;

// ---------- Basics ----------

app.get('/api/test', h(async (req, res) => {
  const r = await pool.query('SELECT NOW()');
  res.json({ ok: true, time: r.rows[0].now });
}));

app.get('/api/config', (req, res) => res.json({ extra_drop_fee: EXTRA_DROP_FEE }));

app.get('/api/areas', h(async (req, res) => {
  const r = await pool.query('SELECT * FROM areas ORDER BY zone, name');
  res.json(r.rows);
}));

app.get('/api/clients', h(async (req, res) => {
  const r = await pool.query('SELECT id, company_name FROM clients ORDER BY company_name');
  res.json(r.rows);
}));

app.post('/api/trucks', h(async (req, res) => {
  const { plate_number, device_id, make_model } = req.body;
  if (!plate_number || !device_id) return bad(res, 400, 'plate_number and device_id are required');
  const r = await pool.query(
    'INSERT INTO trucks (plate_number, device_id, make_model) VALUES ($1, $2, $3) RETURNING *',
    [plate_number.trim(), device_id.trim(), make_model ? make_model.trim() : null]
  );
  res.json(r.rows[0]);
}));

app.get('/api/trucks', h(async (req, res) => {
  const r = await pool.query(`
    SELECT t.*, d.name AS driver_name,
           tr.id AS trip_id, tr.status AS trip_status, c.company_name AS client_name
    FROM trucks t
    LEFT JOIN drivers d ON d.id = t.driver_id
    LEFT JOIN LATERAL (
      SELECT id, status, client_id FROM trips
      WHERE truck_id = t.id AND status IN ('in_progress', 'delivered')
      ORDER BY started_at DESC LIMIT 1
    ) tr ON true
    LEFT JOIN clients c ON c.id = tr.client_id
    ORDER BY t.id`);
  res.json(r.rows);
}));

app.get('/api/trucks/:id', h(async (req, res) => {
  const truck = await pool.query('SELECT * FROM trucks WHERE id = $1', [req.params.id]);
  if (!truck.rows.length) return bad(res, 404, 'Truck not found');
  const latest = await pool.query(
    'SELECT * FROM gps_logs WHERE truck_id = $1 ORDER BY recorded_at DESC LIMIT 1',
    [req.params.id]
  );
  res.json({ ...truck.rows[0], latest_position: latest.rows[0] || null });
}));

app.patch('/api/trucks/:id', h(async (req, res) => {
  const { make_model, year, odometer_km, last_maintained_at, last_parts_bought_at, parts_used, next_service_due, total_maintenance_cost } = req.body;
  const r = await pool.query(
    `UPDATE trucks SET
      make_model = $1, year = $2, odometer_km = $3,
      last_maintained_at = $4, last_parts_bought_at = $5,
      parts_used = $6, next_service_due = $7, total_maintenance_cost = $8
     WHERE id = $9 RETURNING *`,
    [make_model || null, year || null, odometer_km || null, last_maintained_at || null, 
     last_parts_bought_at || null, parts_used || null, next_service_due || null, total_maintenance_cost || 0, req.params.id]
  );
  res.json(r.rows[0]);
}));

// ---------- Maintenance Logs ----------
app.get('/api/trucks/:id/maintenance', h(async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM maintenance_logs WHERE truck_id = $1 ORDER BY date DESC',
    [req.params.id]
  );
  res.json(r.rows);
}));

app.post('/api/trucks/:id/maintenance', h(async (req, res) => {
  const { date, description, cost } = req.body;
  if (!date) return bad(res, 400, 'Date is required');
  
  const r = await pool.query(
    'INSERT INTO maintenance_logs (truck_id, date, description, cost) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.params.id, date, description || null, cost || 0]
  );

  await pool.query(
    `UPDATE trucks SET 
      last_maintained_at = (SELECT MAX(date) FROM maintenance_logs WHERE truck_id = $1),
      total_maintenance_cost = (SELECT SUM(cost) FROM maintenance_logs WHERE truck_id = $1),
      parts_used = $2
     WHERE id = $1`,
    [req.params.id, description]
  );

  res.json(r.rows[0]);
}));

app.get('/api/trucks/:id/history', h(async (req, res) => {
  const r = await pool.query(
    `SELECT latitude, longitude, speed_kmph, recorded_at FROM gps_logs
     WHERE truck_id = $1 ORDER BY recorded_at ASC`,
    [req.params.id]
  );
  res.json(r.rows);
}));

// ---------- Drivers & Assignments ----------
app.get('/api/drivers', h(async (req, res) => {
  const r = await pool.query(`
    SELECT d.*, t.plate_number AS assigned_truck
    FROM drivers d LEFT JOIN trucks t ON t.driver_id = d.id
    ORDER BY d.name
  `);
  res.json(r.rows);
}));

app.post('/api/drivers', h(async (req, res) => {
  const { name, license_no, phone, bio } = req.body;
  if (!name) return bad(res, 400, 'Name is required');
  const r = await pool.query(
    'INSERT INTO drivers (name, license_no, phone, bio) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, license_no || null, phone || null, bio || null]
  );
  res.json(r.rows[0]);
}));

app.put('/api/trucks/:id/driver', h(async (req, res) => {
  const { driver_id } = req.body;
  await pool.query('UPDATE trucks SET driver_id = $1 WHERE id = $2', [driver_id || null, req.params.id]);
  res.json({ ok: true });
}));

// ---------- 1. Dispatch ----------
app.post('/api/dispatch', h(async (req, res) => {
  const { truck_id, dispatched_at } = req.body;
  const t = await pool.query('SELECT status FROM trucks WHERE id = $1', [truck_id]);
  if (!t.rows.length) return bad(res, 404, 'Truck not found');
  if (['dispatched', 'in_transit'].includes(t.rows[0].status)) return bad(res, 409, 'That truck is already out');
  
  const finalDate = dispatched_at ? dispatched_at + 'T12:00:00' : null;
  
  await pool.query(
    `UPDATE trucks SET status = 'dispatched', dispatched_at = COALESCE($2::timestamptz, NOW()) WHERE id = $1`,
    [truck_id, finalDate]
  );
  res.json({ ok: true });
}));

// ---------- 2. GPS ingest ----------
app.post('/api/gps', h(async (req, res) => {
  const { device_id, lat, lng, speed, timestamp } = req.body;
  if (!Number.isFinite(+lat) || !Number.isFinite(+lng)) return bad(res, 400, 'lat and lng are required');

  const truck = await pool.query('SELECT id FROM trucks WHERE device_id = $1', [device_id]);
  if (!truck.rows.length) return bad(res, 404, 'Unknown device');
  const truckId = truck.rows[0].id;

  const tripRes = await pool.query(
    `SELECT * FROM trips WHERE truck_id = $1 AND status = 'in_progress'
     ORDER BY started_at DESC LIMIT 1`,
    [truckId]
  );
  const trip = tripRes.rows[0] || null;

  await pool.query(
    `INSERT INTO gps_logs (truck_id, trip_id, latitude, longitude, speed_kmph, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [truckId, trip ? trip.id : null, +lat, +lng, speed == null ? null : +speed, timestamp ? new Date(timestamp) : new Date()]
  );

  if (trip && trip.destination_lat != null && trip.destination_lng != null) {
    const eta = calculateETA(+lat, +lng, +speed, trip.destination_lat, trip.destination_lng);
    await pool.query('UPDATE trips SET estimated_arrival = $1 WHERE id = $2', [eta, trip.id]);
  }

  res.json({ ok: true, trip_id: trip ? trip.id : null });
}));

// ---------- 3. Trips ----------
app.post('/api/trips', h(async (req, res) => {
  const { truck_id, client_name, address, allowance_amount, started_at } = req.body;
  let { destination_lat: lat, destination_lng: lng } = req.body;
  let addr = (address || '').trim() || null;

  if (!(client_name || '').trim()) return bad(res, 400, 'Client / destination is required');
  const truck = await pool.query('SELECT * FROM trucks WHERE id = $1', [truck_id]);
  if (!truck.rows.length) return bad(res, 404, 'Truck not found');

  const clientId = await getOrCreateClient(client_name);

  if (lat == null || lng == null) {
    lat = lng = null;
    if (addr) {
      const g = await geocode(addr);
      if (g) {
        lat = g.lat;
        lng = g.lng;
        await pool.query('UPDATE clients SET address = $1, lat = $2, lng = $3 WHERE id = $4', [addr, lat, lng, clientId]);
      }
    } else {
      const c = await pool.query('SELECT address, lat, lng FROM clients WHERE id = $1', [clientId]);
      if (c.rows[0] && c.rows[0].lat != null) {
        lat = c.rows[0].lat;
        lng = c.rows[0].lng;
        addr = c.rows[0].address;
      }
    }
  }

  const allowance = allowance_amount === '' || allowance_amount == null ? null : Number(allowance_amount);
  const finalStartedAt = started_at ? started_at + 'T12:00:00' : null; 

  const tripRes = await pool.query(
    `INSERT INTO trips (truck_id, client_id, destination_address, destination_lat, destination_lng, allowance_amount, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', COALESCE($7::timestamptz, NOW())) RETURNING id`,
    [truck_id, clientId, addr, lat, lng, Number.isFinite(allowance) ? allowance : null, finalStartedAt]
  );
  const tripId = tripRes.rows[0].id;

  // Backfill: everything this truck reported since it was dispatched belongs to this trip.
  const dispatchedAt = truck.rows[0].dispatched_at || new Date(0);
  await pool.query(
    `UPDATE gps_logs SET trip_id = $1 WHERE truck_id = $2 AND trip_id IS NULL AND recorded_at >= $3`,
    [tripId, truck_id, dispatchedAt]
  );

  await pool.query(`UPDATE trucks SET status = 'in_transit' WHERE id = $1`, [truck_id]);

  if (lat != null && lng != null) {
    const p = await pool.query(
      'SELECT latitude, longitude, speed_kmph FROM gps_logs WHERE truck_id = $1 ORDER BY recorded_at DESC LIMIT 1',
      [truck_id]
    );
    if (p.rows[0]) {
      const eta = calculateETA(p.rows[0].latitude, p.rows[0].longitude, p.rows[0].speed_kmph, lat, lng);
      await pool.query('UPDATE trips SET estimated_arrival = $1 WHERE id = $2', [eta, tripId]);
    }
  }

  res.json({ ok: true, trip_id: tripId });
}));

app.get('/api/trips/awaiting-billing', h(async (req, res) => {
  const r = await pool.query(`${TRIP_SELECT} WHERE tr.status = 'awaiting_billing' ORDER BY tr.finalized_at`);
  res.json(r.rows);
}));

app.get('/api/trips/pending-waybill', h(async (req, res) => {
  const r = await pool.query(`${TRIP_SELECT} WHERE tr.status IN ('in_progress', 'delivered') ORDER BY tr.started_at`);
  res.json(r.rows);
}));

app.get('/api/trips', h(async (req, res) => {
  const { date } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return bad(res, 400, 'date=YYYY-MM-DD is required');
  const r = await pool.query(
    `${TRIP_SELECT} WHERE (tr.started_at AT TIME ZONE 'Asia/Manila')::date = $1::date ORDER BY tr.started_at`,
    [date]
  );
  res.json(r.rows);
}));

app.get('/api/history', h(async (req, res) => {
  const { search, status } = req.query;
  let query = `
    SELECT tr.*, t.plate_number, d.name AS driver_name, c.company_name AS client_name
    FROM trips tr
    JOIN trucks t ON t.id = tr.truck_id
    LEFT JOIN drivers d ON d.id = t.driver_id
    LEFT JOIN clients c ON c.id = tr.client_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { params.push(status); query += ` AND tr.status = $${params.length}`; }
  if (search) { 
    params.push(`%${search}%`); 
    query += ` AND (tr.waybill_number ILIKE $${params.length} OR c.company_name ILIKE $${params.length} OR t.plate_number ILIKE $${params.length})`; 
  }
  query += ` ORDER BY tr.started_at DESC LIMIT 50`;
  const r = await pool.query(query, params);
  res.json(r.rows);
}));

app.get('/api/trips/:id/details', h(async (req, res) => {
  const trip = await pool.query(`
    SELECT tr.*, t.plate_number, d.name AS driver_name, c.company_name AS client_name
    FROM trips tr
    JOIN trucks t ON t.id = tr.truck_id
    LEFT JOIN drivers d ON d.id = t.driver_id
    LEFT JOIN clients c ON c.id = tr.client_id
    WHERE tr.id = $1
  `, [req.params.id]);
  if (!trip.rows.length) return bad(res, 404, 'Trip not found');

  const stops = await pool.query(`
    SELECT s.*, a.name AS area_name, a.zone AS area_zone
    FROM trip_stops s LEFT JOIN areas a ON a.id = s.area_id
    WHERE s.trip_id = $1 ORDER BY s.sequence_number
  `, [req.params.id]);

  const invoice = await pool.query('SELECT * FROM invoices WHERE trip_id = $1', [req.params.id]);
  res.json({ ...trip.rows[0], stops: stops.rows, invoice: invoice.rows[0] || null });
}));

app.get('/api/trips/:id', h(async (req, res) => {
  const r = await pool.query(`${TRIP_SELECT} WHERE tr.id = $1`, [req.params.id]);
  if (!r.rows.length) return bad(res, 404, 'Trip not found');
  const trip = r.rows[0];
  const pos = await pool.query(
    `SELECT latitude, longitude, speed_kmph, recorded_at FROM gps_logs
     WHERE truck_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [trip.truck_id]
  );
  res.json({ ...trip, latest_position: pos.rows[0] || null });
}));

app.get('/api/trips/:id/stops', h(async (req, res) => {
  const r = await pool.query(
    `SELECT s.*, a.name AS area_name, a.zone AS area_zone
     FROM trip_stops s LEFT JOIN areas a ON a.id = s.area_id
     WHERE s.trip_id = $1 ORDER BY s.sequence_number`,
    [req.params.id]
  );
  res.json(r.rows);
}));

app.get('/api/calendar', h(async (req, res) => {
  const { month } = req.query;
  if (!/^\d{4}-\d{2}$/.test(month || '')) return bad(res, 400, 'month=YYYY-MM is required');
  const r = await pool.query(
    `SELECT to_char((started_at AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'in_progress')::int AS ongoing,
            COUNT(*) FILTER (WHERE status = 'delivered')::int AS pending_waybill,
            COUNT(*) FILTER (WHERE status = 'awaiting_billing')::int AS awaiting_billing,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
     FROM trips
     WHERE (started_at AT TIME ZONE 'Asia/Manila')::date >= ($1::text || '-01')::date
       AND (started_at AT TIME ZONE 'Asia/Manila')::date < (($1::text || '-01')::date + interval '1 month')::date
     GROUP BY 1 ORDER BY 1`,
    [month]
  );
  res.json(r.rows);
}));

// ---------- 4. Delivered ----------
app.patch('/api/trips/:id/delivered', h(async (req, res) => {
  const t = await pool.query('SELECT truck_id, status FROM trips WHERE id = $1', [req.params.id]);
  if (!t.rows.length) return bad(res, 404, 'Trip not found');
  if (t.rows[0].status !== 'in_progress') return bad(res, 409, 'This trip is not on the road');
  await pool.query(`UPDATE trips SET status = 'delivered', delivered_at = NOW() WHERE id = $1`, [req.params.id]);
  await pool.query(`UPDATE trucks SET status = 'awaiting_billing' WHERE id = $1`, [t.rows[0].truck_id]);
  res.json({ ok: true });
}));

// ---------- 5. Waybill ----------
app.patch('/api/trips/:id/waybill', h(async (req, res) => {
  const wb = ((req.body.waybill_number) || '').trim();
  const stops = req.body.stops;
  if (!wb) return bad(res, 400, 'Waybill number is required');
  if (!Array.isArray(stops) || !stops.length) return bad(res, 400, 'Add at least one stop');
  const main = stops.find((s) => s.stop_type === 'main');
  if (!main) return bad(res, 400, 'A main destination is required');
  if (stops.some((s) => !(s.client_name || '').trim())) return bad(res, 400, 'Every stop needs a client name');

  const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
  if (!tripRes.rows.length) return bad(res, 404, 'Trip not found');
  const trip = tripRes.rows[0];
  if (trip.status === 'in_progress') return bad(res, 409, 'Mark the trip as delivered first');
  if (trip.status !== 'delivered') return bad(res, 409, 'This trip already has a waybill');

  const db = await pool.connect();
  let total = 0;
  try {
    await db.query('BEGIN');
    let seq = 0;
    for (const s of stops) {
      const type = ['main', 'additional', 'extra'].includes(s.stop_type) ? s.stop_type : 'additional';
      const n = s.rate === '' || s.rate == null ? NaN : Number(s.rate);
      const rate = Number.isFinite(n) ? n : type === 'extra' ? EXTRA_DROP_FEE : 0;
      total += rate;
      await db.query(
        `INSERT INTO trip_stops
           (trip_id, stop_type, client_name, address, area_id, dr_number, rate, waybill_type, drop_type, notes, sequence_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [trip.id, type, s.client_name.trim(), s.address || null, s.area_id || null, s.dr_number || null,
         rate, s.waybill_type || null, s.drop_type || null, s.notes || null, ++seq]
      );
    }
    const clientId = await getOrCreateClient(main.client_name, db);
    await db.query(
      `UPDATE trips
       SET waybill_number = $1, waybill_total = $2, client_id = COALESCE($3, client_id),
           status = 'awaiting_billing', delivered_at = COALESCE(delivered_at, NOW()), finalized_at = NOW()
       WHERE id = $4`,
      [wb, total, clientId, trip.id]
    );
    await db.query(`UPDATE trucks SET status = 'idle' WHERE id = $1 AND status = 'awaiting_billing'`, [trip.truck_id]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
  res.json({ ok: true, total });
}));

// ---------- 6. Invoice ----------
app.post('/api/trips/:id/invoice', h(async (req, res) => {
  const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
  if (!tripRes.rows.length) return bad(res, 404, 'Trip not found');
  const trip = tripRes.rows[0];
  if (trip.status === 'completed') return bad(res, 409, 'This trip is already invoiced');
  if (trip.status !== 'awaiting_billing') return bad(res, 400, 'Submit the waybill first');

  const distanceKm = await getTotalTripDistance(trip.id); 
  const db = await pool.connect();
  let invoiceId;
  try {
    await db.query('BEGIN');
    const inv = await db.query(
      `INSERT INTO invoices (client_id, trip_id, amount, due_at)
       VALUES ($1, $2, $3, NOW() + interval '30 days') RETURNING id`,
      [trip.client_id, trip.id, trip.waybill_total]
    );
    invoiceId = inv.rows[0].id;
    await db.query(`UPDATE trips SET status = 'completed', distance_km = $1 WHERE id = $2`, [distanceKm, trip.id]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
  res.json({ ok: true, invoice_id: invoiceId, amount: trip.waybill_total, gps_distance_km: distanceKm });
}));

app.get('/api/invoices', h(async (req, res) => {
  const r = await pool.query(
    `SELECT i.*, c.company_name AS client_name, tr.waybill_number
     FROM invoices i
     LEFT JOIN clients c ON c.id = i.client_id
     LEFT JOIN trips tr ON tr.id = i.trip_id
     ORDER BY i.issued_at DESC`
  );
  res.json(r.rows);
}));

app.post('/api/invoices/:id/pay', h(async (req, res) => {
  await pool.query(`UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Delete Routes ----------
app.delete('/api/drivers/:id', h(async (req, res) => {
  await pool.query('UPDATE trucks SET driver_id = NULL WHERE driver_id = $1', [req.params.id]);
  const r = await pool.query('DELETE FROM drivers WHERE id = $1 RETURNING id', [req.params.id]);
  if (!r.rows.length) return bad(res, 404, 'Driver not found');
  res.json({ ok: true });
}));

app.delete('/api/trucks/:id', h(async (req, res) => {
  const truckId = req.params.id;
  
  const invoices = await pool.query(`
    SELECT i.id FROM invoices i 
    JOIN trips tr ON tr.id = i.trip_id 
    WHERE tr.truck_id = $1
  `, [truckId]);

  if (invoices.rows.length > 0) {
    return bad(res, 400, 'Cannot delete truck: it has generated invoices. Keep it for historical records.');
  }

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('DELETE FROM maintenance_logs WHERE truck_id = $1', [truckId]);
    await db.query('DELETE FROM gps_logs WHERE truck_id = $1', [truckId]);
    
    const trips = await db.query('SELECT id FROM trips WHERE truck_id = $1', [truckId]);
    const tripIds = trips.rows.map(r => r.id);
    if (tripIds.length > 0) {
      await db.query('DELETE FROM trip_stops WHERE trip_id = ANY($1::int[])', [tripIds]);
      await db.query('DELETE FROM trips WHERE truck_id = $1', [truckId]);
    }
    
    await db.query('DELETE FROM trucks WHERE id = $1', [truckId]);
    
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FleetTrack running on port ${PORT}`));