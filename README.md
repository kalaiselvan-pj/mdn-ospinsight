# Medianet OSP Insight

Network map for the Medianet GPON outside plant. It replaces the hosted OSPInsight site with a local login, Google Map, and the same network objects: buildings, cables, access points, splices, and term points.

## Laptop

1. The app uses its own PostgreSQL on port 5433, so the existing office database on port 5432 is left as it is. Start it with `start-office.ps1`, or point `DATABASE_URL` at another server.
2. Install and load the migrated network:

```
npm install
npm run harvest
npm run setup
npm start
```

Open http://localhost:8080 and sign in with the Medianet_Edit account.

`npm run harvest` reads the current OSPInsight server and writes `data/`. `npm run setup` creates the `medianet_ospinsight` database and loads that data. Starting the app again does not download the old server.

## Office virtual machine

Copy this folder, including `.env` and `data/`, onto the VM. Install Docker, then:

```
docker compose up -d --build
```

The site listens on port 8080. The database lives in the `ospdata` Docker volume. On first start the app loads `data/` if the feature table is empty.

Google Maps draws the network, so the VM needs outbound access to Google and the browser key must allow the VM address.
