# Medianet Atlas

The outside plant map for Medianet across Malé, Hulhumalé and Addu City the islands.

Medianet Atlas is the map for the Medianet GPON network. Sign in, open the network on Google Maps, and work with buildings, cables, access points, splices, and term points. The network is stored in a local PostgreSQL database.

## What you can do

- Sign in with the Medianet account.
- Browse the network map. Buildings, cables, splices, and access points draw once you zoom in.
- Search for an object and open it to view or edit its attributes.
- Draw new buildings, cables, and equipment on the map.
- Use the sidebar for the network, default types, attributes, themes, bookmarks, alarms, field notes, the log, and settings.

## Use this application

The network is in `db/medianet_ospinsight.sql.gz`. Restore that file into a local PostgreSQL database that is only for this application.

1. Install Node.js and PostgreSQL.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL` to that local database, set `JWT_SECRET` to a long random string, and set `GOOGLE_MAPS_API_KEY`.
4. Install, restore, and start:

```
npm install
npm run restore
npm start
```

Open http://localhost:8080 and sign in as `Medianet_Edit`. The password is the Medianet account password. The restore creates that login in the database.

`npm run restore` writes only to the database named in `DATABASE_URL`.
