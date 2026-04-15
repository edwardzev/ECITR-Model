# Orchestrator Runtime

## Purpose

Define the first executable runtime surface for the Orchestrator.

## Core Rule

The Orchestrator routes explicit task packets through a role registry.

It does not improvise hidden ownership.

## Runtime Stages

1. accept a task packet
2. classify affected layers and change class
3. choose a primary role
4. choose supporting roles when needed
5. mark whether orchestrator review remains required
6. emit a delegation plan

## Role Rule

Every routed task must name:
- a primary role
- zero or more supporting roles
- whether Researcher is required
- whether Governance and QA review is required

## Escalation Rule

The runtime must force explicit orchestrator review for:
- cross-layer work
- retrieval-class changes
- contract-class changes
- external-adaptation changes
