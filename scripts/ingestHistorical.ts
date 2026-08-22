import { ingestHistoricalData } from "@/lib/historical/ingest";

ingestHistoricalData()
  .then((summary) => {
    console.log(
      `Historical data written: ${summary.players} players, ${summary.matchStats} match rows, ${summary.mappings} mappings.`,
    );
    if (!summary.currentDataAvailable) {
      console.warn("Live FPL bootstrap was unavailable; historical files were written without current-player mappings.");
    }
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Historical ingestion failed");
    process.exitCode = 1;
  });
