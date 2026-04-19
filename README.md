# strudel.cc sampler-server

Extended functionality (added tracks support, samples as normalized_filename-as-key => value)
https://strudel.cc/learn/samples/#generating-strudeljson

```bash
http://localhost:5432/strudel.json # both legacy and aliases
http://localhost:5432/legacy.json # only legacy (as @strudel/sampler)
http://localhost:5432/aliases.json # only aliases
http://localhost:5432/track-name/strudel.json
```

## usage

```bash
PORT=5432 SAMPLES_ROOT="./samples" TRACKS_ROOT="./tracks" node sampler-server.js
```
