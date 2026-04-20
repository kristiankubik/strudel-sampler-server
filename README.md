# strudel.cc sampler-server

Extended functionality (added tracks support, samples as normalized_filename-as-key => value)
https://strudel.cc/learn/samples/#generating-strudeljson

## example directory structure

env file variables:

- SAMPLES_ROOT: samples
- TRACKS_ROOT: tracks (inside, a folder with track-name, inside is the same structure as in <root>)

```
<root>/
├── prebake.js - here to keep the global prebake
├── samples/
│   ├── <Cym>/
│   │   └── audio-file
│   └── <drumkit_name>/
│       └── <Perc>/
│           └── audio-file
└── tracks/
    └── <track-name>/
        └── samples/
            ├── <Cym>/
            │   └── audio-file
            ├── <drumkit_name>/
            │   └── <Perc>/
            │       └── audio-file
            ├── prebake.js - here to keep the per-track prebake
            └── strudel.js - here to keep the track
```

## available endpoints

```bash
# global
http://localhost:5432/strudel.json # both legacy and aliases
http://localhost:5432/legacy.json # only legacy (as @strudel/sampler)
http://localhost:5432/aliases.json # only aliases

# per-track
http://localhost:5432/<track-name>/aliases.json
http://localhost:5432/<track-name>/legacy.json
http://localhost:5432/<track-name>/strudel.json
```

## usage

```bash
PORT=5432 SAMPLES_ROOT="./samples" TRACKS_ROOT="./tracks" node sampler-server.js
```
