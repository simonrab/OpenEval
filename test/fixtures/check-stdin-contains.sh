#!/usr/bin/env bash
# Fixture check: pass when stdin contains the literal "PASS".
input="$(cat)"
if [[ "$input" == *PASS* ]]; then
  exit 0
fi
exit 1
