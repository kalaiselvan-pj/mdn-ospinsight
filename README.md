# Medianet OSP Insight

Network map for the Medianet GPON outside plant. It replaces the hosted OSPInsight site with a local login, Google Map, and the same network objects: buildings, cables, access points, splices, and term points.

## Another computer

The network is already in `db/medianet_ospinsight.sql.gz`. Restore that file into your own local PostgreSQL. The app does not connect to the old OSPInsight server.

1. Install Node.js and PostgreSQL.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL` to your local database, set `JWT_SECRET` to any long random string, and set `GOOGLE_MAPS_API_KEY`.
4. Install, restore, and start:

```
npm install
npm run restore
npm start
```

Open http://localhost:8080 and sign in as `Medianet_Edit`. The password is the office account password shared with you. The restore creates that login in your database.

`npm run restore` only writes to the database named in `DATABASE_URL`. Use a database that is only for this app.

## This office laptop

The app uses its own PostgreSQL on port 5433, so the office database on port 5432 is left as it is. Start it with `start-office.ps1`. The network is already loaded there. `npm run dump` refreshes `db/medianet_ospinsight.sql.gz` from that database.

## Office virtual machine

Copy this folder, including `.env`, onto the VM. Install Docker, then:

```
docker compose up -d --build
```

The site listens on port 8080. The database lives in the `ospdata` Docker volume. Restore `db/medianet_ospinsight.sql.gz` into that database. The app does not download the old OSPInsight server.

Google Maps draws the network, so the VM needs outbound access to Google and the browser key must allow the VM address.
