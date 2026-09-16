# CMPRI UniMac UTF75 Dryer Troubleshooting Source
Date: 2026-09-16
Status: Verified OEM source identified; not yet linked to live dryer assets

## Equipment identity
CMPRI historical equipment/work-order data identifies a dryer as:

`Alliance UTF75RUF6A2W01`

The Alliance Laundry Systems OEM model family includes the 75 lb UniMac `UTF75L` and `UTF75N` tumble dryers.

## Correct OEM troubleshooting source
Alliance Laundry Systems:

- **Tumble Dryer Troubleshooting Manual**
- Part No. **70398301R2**
- December 2016
- 50 lb and 75 lb capacity tumble dryers
- Model-identification section includes `UTF75L` and `UTF75N`

OEM source URL observed during audit:
`https://parts.alliancelaundry.com/files/docs/alliance/ALPM-70398301.pdf`

A newer/alternate troubleshooting manual is also published for later units. CMPRI should select the correct control/serial branch only after the live dryer serial/control identity is recorded.

## Important Drive defect
The three connected-Drive files titled `BoH Dryer UTF75RUF6A2W01.pdf` were inspected and are **not dryer manuals**. Their actual content is Alliance Laundry Systems Pocket Hardmount Washer-Extractor parts manual F8453401.

Do not build dryer troubleshooting from those files and do not mark them verified for the dryer asset.

## Model-family-safe troubleshooting guidance
The following guidance is supported by the OEM 70398301R2 troubleshooting manual and is safe as a general UTF75-family diagnostic route, while control-specific branches remain conditional.

### Long dry times / clothes do not dry
Check, in an issue-driven order:

1. Confirm the heat source is actually operating.
2. Check whether the load entered the dryer with excessive retained water.
3. Check whether the dryer is overloaded.
4. Check the exhaust system for improper sizing, restriction, or inadequate flow.
5. Check whether the heat source is shutting off prematurely.
6. Check the drying-time/selector setting where applicable.
7. Verify supply voltage against the installation/electrical requirements where appropriate.
8. Check make-up-air adequacy.

### Airflow / lint / exhaust
Before adjusting the airflow switch, check and correct:

- clogged lint screen,
- lint in the dryer ducting,
- lint/obstruction in the external exhaust system,
- inadequate make-up air,
- obstruction at the thimble/main/collector duct,
- backdraft-damper obstruction or lint accumulation,
- lint-panel fit/closure.

The OEM manual states that an airflow switch opening or cycling during operation indicates insufficient airflow; when the switch opens, heat shuts off while the cylinder and fan can continue running.

This behavior is highly relevant to a complaint of **long dry times**.

### Overheating route
The OEM manual's overheating route includes checks for:

- gas burner/orifice configuration where applicable,
- gas pressure against the serial plate where applicable,
- inadequate make-up air,
- lint accumulation,
- restricted/inadequate exhaust,
- thermistor operation,
- cabinet/burner limit thermostats.

The manual provides a thermistor test of approximately **50,000 ohms at 77°F**, with resistance decreasing as temperature increases. This value should only be shown when the selected dryer is confirmed to fall under this manual and the technician is in the applicable diagnostic branch.

## Historical CMPRI relevance
A completed historical CMPRI dryer work order for the Alliance UTF75 dryer reported long dry times. The repair involved cleaning heavy lint buildup from the exhaust run/exterior damper and verifying airflow-switch operation, after which airflow and dry time returned to normal.

That history may be shown as **Relevant History**, but the app must not assume the same root cause for every future long-dry-time complaint.

## Required follow-up before direct live linkage
Record/verify on the live dryer asset:

- exact full model from serial plate,
- serial number,
- gas/electric/steam configuration,
- control type/suffix.

Then choose the matching OEM troubleshooting revision/control branch and create the structured `troubleshooting_cache` payload.
