# model-hub Python client

Project-side client for [model-hub](../../../). It pulls the projected
catalog for a project, caches it on disk with `0600` permissions, and
resolves models by alias or modality. Projects call providers directly
with the issued credentials; the hub is never in the inference path.

## Install

Consumed via a Git tag (no private registry):

```bash
pip install "model-hub-client @ git+ssh://git@<host>/model-hub.git@v0.1.0#subdirectory=clients/python"
```

## Usage

```python
from model_hub_client import ModelHubClient

client = ModelHubClient(
    hub_url="https://model-hub.internal",
    token=os.environ["MODEL_HUB_TOKEN"],
    cache_path="./data/model-cache.json",
)
client.pull()

model = client.resolve("noul")          # alias assigned in the console
# model["base_url"], model["api_key"], model["model"], model["pricing"]

primary = client.primary("text")        # role=primary for a modality
```

If the hub is unreachable, `pull()` keeps the last good cache so the
project keeps running. Terminal-user BYOK is outside this client's scope.

## Test

```bash
PYTHONPATH=. python3 -m unittest discover -s tests
```

Tests use the shared contract fixture at
`contracts/fixtures/models-response.example.json`.
