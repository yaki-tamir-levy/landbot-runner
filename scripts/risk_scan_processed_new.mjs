name: OpenAI smoke test (risk scan)

on:
  workflow_dispatch:
    inputs:
      openai_model:
        description: "OpenAI model (default gpt-5.2)"
        required: false
        default: "gpt-5.2"
        type: string
      batch_size:
        description: "Batch size (default 50)"
        required: false
        default: "50"
        type: string
      max_items:
        description: "Max items to process (0 = no limit)"
        required: false
        default: "0"
        type: string

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 25

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 18

      - name: Run risk scan (processed=NEW)
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_MODEL: ${{ inputs.openai_model }}
          BATCH_SIZE: ${{ inputs.batch_size }}
          MAX_ITEMS: ${{ inputs.max_items }}
        run: |
          node scripts/risk_scan_processed_new.mjs
