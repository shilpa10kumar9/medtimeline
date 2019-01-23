// Copyright 2018 Verily Life Sciences Inc.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

import {DateTime} from 'luxon';

import {BCHMicrobioCode} from '../clinicalconcepts/bch-microbio-code';
import {LOINCCode} from '../clinicalconcepts/loinc-code';
import {ResourceCode} from '../clinicalconcepts/resource-code-group';
import {LabeledClass} from '../fhir-resource-set';
import {OBSERVATION_INTERPRETATION_VALUESET_URL, ObservationInterpretation} from './observation-interpretation-valueset';


/**
 * These are the quantity attributes provided by FHIR. See
 * https://www.hl7.org/fhir/datatypes.html#quantity
 */
interface Quantity {
  value: number;
  comparator: string;
  unit: string;
  system: string;
  code: string;
}

/**
 * This object represents a FHIR Observation. It does not contain all the
 * information in a standard Observation
 * (see https://www.hl7.org/fhir/observation.html#resource) but instead stores
 * only the information we're interested in seeing.
 */
export class Observation extends LabeledClass {
  readonly codes: ResourceCode[] = [];
  timestamp: DateTime;
  readonly value: Quantity;
  // Populated if the Observation contains a qualitative result, such
  // as "Yellow", rather than a numerical value.
  readonly result: string;
  readonly normalRange: [number, number];
  readonly unit: string;
  readonly innerComponents: Observation[] = [];
  // The display string associated with the code for this Observation.
  readonly display: string;
  readonly interpretation: ObservationInterpretation;


  /**
   * Makes an Observation out of a JSON object that represents a
   * a FHIR observation.
   * @param json A JSON object that represents a FHIR observation.
   */
  constructor(private json: any) {
    super();
    // TODO(b/111990521): If there are hours and minutes then we can
    // guarantee timezone is specified, but if not, then the timezone might
    // not be specified! I'm not sure how to best handle that.
    // https://www.hl7.org/fhir/DSTU2/datatypes.html#dateTime
    this.timestamp = json.effectiveDateTime ?
        DateTime.fromISO(json.effectiveDateTime).toUTC() :
        json.issued ? DateTime.fromISO(json.issued).toUTC() : null;
    if (json.code) {
      this.label = json.code.text;
      if (json.code.coding) {
        // TODO(b/121318193): Implement better parsing of Observations with BCH
        // Codes (associated with Microbiology data).
        if (json.code.coding[0].system === BCHMicrobioCode.CODING_STRING) {
          this.codes = json.code.coding.map(
              (coding) => BCHMicrobioCode.fromCodeString(coding.code));
          this.display = json.code.coding[0].display;
          this.label = this.display;
        } else {
          this.codes =
              json.code.coding
                  .map(
                      // Map the codes to a boolean that is true only if the
                      // encoding is a LOINC encoding, and the LOINC code appeas
                      // in our LOINCCode list that we care about.
                      (coding) => (!coding.system ||
                                   coding.system.indexOf(
                                       LOINCCode.CODING_STRING) !== -1) &&
                          LOINCCode.fromCodeString(coding.code))
                  // Filter out any codes that are not LOINC codes.
                  .filter((code) => !!code);
        }
      }
    }

    if (json.interpretation && json.interpretation.coding) {
      const coding = json.interpretation.coding[0];
      if (coding.system === OBSERVATION_INTERPRETATION_VALUESET_URL) {
        if (ObservationInterpretation.codeToObject.has(coding.code)) {
          this.interpretation =
              ObservationInterpretation.codeToObject.get(coding.code);
        } else {
          throw Error(
              'Unsupported interpretation code: ' + JSON.stringify(coding));
        }
      }
      // Silently ignore encodings coming from other systems.
    }


    if (json.component) {
      json.component.forEach(element => {
        const innerObs = new Observation(element);
        if (!innerObs.timestamp) {
          innerObs.timestamp = this.timestamp;
        }
        this.innerComponents.push(innerObs);
      });
    }

    if (!this.codes || this.codes.length === 0) {
      throw Error(
          'Observations have to have a LOINC code to be useful. ' +
          'JSON: ' + JSON.stringify(json));
    }

    if (!this.label) {
      throw Error(
          'Observations have to have a label to be useful. ' +
          'JSON: ' + JSON.stringify(json));
    }

    /*
    TODO(b/119673528): Work out which labels we're going to use for BCH, then
    re-enable.
    // Check the observation label against the LOINC code label.
    if (this.label !== this.loincCodes[0].label) {
      throw Error(
          'The label for this observation\'s LOINC code doesn\'t match ' +
          ' the label in the data. Observation label: ' + this.label +
          ' LOINC label: ' + this.loincCodes[0].label);
    }
    */

    this.value = json.valueQuantity ? json.valueQuantity : null;
    if (this.value) {
      this.unit = this.value.unit;
    }

    this.result =
        json.valueCodeableConcept ? json.valueCodeableConcept.text : null;

    // TODO(b/121318193): Impement better parsing of Observations with BCH Codes
    // (associated with Microbiology data). These Observations might not have
    // values or results.
    if (this.value === null && this.result === null &&
        this.interpretation === null && this.innerComponents.length === 0) {
      throw Error(
          'An Observation must have a value, result, inner components, ' +
          'or an interpretation to be useful. JSON: ' + JSON.stringify(json));
    }

    // The FHIR standard says that if there's only one range then it should be
    // what is "normal" for that measure. Otherwise they should be labeled.
    // We are going to err on the side of safety and not include a normal range
    // unless there's just the one, and it includes a high and low field.
    // https://www.hl7.org/fhir/DSTU2/observation.html#4.20.4.4
    // TODO(b/113575661): handle multiple ranges
    if (json.referenceRange && json.referenceRange.length === 1) {
      if (json.referenceRange[0].low && json.referenceRange[0].high) {
        this.normalRange = [
          json.referenceRange[0].low.value, json.referenceRange[0].high.value
        ];
      }
    }
  }
}