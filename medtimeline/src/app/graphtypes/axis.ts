// Copyright 2018 Verily Life Sciences Inc.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

import {Interval} from 'luxon';

import {BCHMicrobioCode, BCHMicrobioCodeGroup} from '../clinicalconcepts/bch-microbio-code';
import {DisplayGrouping} from '../clinicalconcepts/display-grouping';
import {LOINCCode, LOINCCodeGroup} from '../clinicalconcepts/loinc-code';
import {ResourceCodeGroup} from '../clinicalconcepts/resource-code-group';
import {RxNormCode} from '../clinicalconcepts/rx-norm';
import {RxNormCodeGroup} from '../clinicalconcepts/rx-norm-group';
import {MedicationOrder, MedicationOrderSet} from '../fhir-data-classes/medication-order';
import {FhirService} from '../fhir.service';
import {GraphData} from '../graphdatatypes/graphdata';
import {LineGraphData} from '../graphdatatypes/linegraphdata';
import {StepGraphData} from '../graphdatatypes/stepgraphdata';

import {ChartType} from './graph/graph.component';

/**
 * An axis represents one graph to be rendered. It
 * holds values for the type of graph (step, scatter, line, etc) as well as the
 * actual graph data.
 *
 * One axis might have multiple ResourceCodes associated with it, but all of
 * the same type.
 *
 * This class makes the FHIR calls to grab the associated data for the chart.
 */
export class Axis {
  /**
   * The ResourceCodeGroup for this axis.
   */
  readonly resourceGroup: ResourceCodeGroup;

  /**
   * The chart type for this graph.
   */
  readonly chartType: ChartType;

  /**
   * The data to display on this graph.
   */
  data: GraphData;

  /**
   * The associated DisplayGrouping for this graph.
   */
  displayConcept: DisplayGrouping;

  /*
   * The date range the graph should display data for.
   */
  readonly dateRange: Interval;

  /*
   * Whether or not the data fetch promise has resolved.
   */
  isResolved = false;

  // TODO(b/118874488): A majority of the code below is copied from
  // multigraphcard and should be removed from multigraphcard once all
  // restructuring is done.
  /**
   * The constructor for this axis.
   * @param fhirService The FhirService used to make the FHIR calls.
   * @param resourceGroup The ResourceGroup to request data for.
   * @param dateRange: The date range to display on the axis.
   */
  constructor(
      private fhirService: FhirService, resourceGroup: ResourceCodeGroup,
      dateRange: Interval) {
    this.dateRange = dateRange;
    this.chartType = resourceGroup.chartType;
    this.displayConcept = resourceGroup.displayGrouping;
    this.resourceGroup = resourceGroup;
    this.getDataFromFhir().then(res => {
      this.data = res;
      this.isResolved = true;
    });
  }

  /**
   * Gets the appropriate GraphData by classifying the resource codes and
   * making the appropriate FHIR calls for data and transformations. If
   * the data is already set in this class, it just returns that data.
   *
   * @returns A GraphData promise that will resolve to the GraphData for
   *    this axis's resourceGroup.
   */
  getDataFromFhir(): Promise<GraphData> {
    if (this.data) {
      return Promise.resolve(this.data);
    }

    const resourceCodeList = this.resourceGroup.resourceCodes;
    // Check that all elements of the resourceCodeList are of the same type.
    const allLoinc = resourceCodeList.every(code => code instanceof LOINCCode);
    const allRx = resourceCodeList.every(code => code instanceof RxNormCode);
    const allBCHMicrobio =
        resourceCodeList.every(code => code instanceof BCHMicrobioCode);
    if (!allLoinc && !allRx && !allBCHMicrobio) {
      throw Error('All resource codes must be of the same type.');
    }
    if (allRx) {
      // Prescriptions can be plotted as a step chart or as a line chart.
      if (this.chartType === ChartType.STEP) {
        return this.getStepGraphDataForMedicationSummary(
            this.resourceGroup as RxNormCodeGroup);
      } else {
        return this.getLineGraphDataForMedicationDetail(
            this.resourceGroup as RxNormCodeGroup);
      }

    } else if (allBCHMicrobio) {
      // Microbiology always shows up as a step chart.
      return this.getStepGraphDataForMB(
          this.resourceGroup as BCHMicrobioCodeGroup);
    } else if (allLoinc) {
      // We use LineGraphData for both ChartType.Scatter and
      // ChartType.Line, for plotting LOINC Codes.
      return (this.resourceGroup as LOINCCodeGroup)
          .getResourceSet(this.dateRange)
          .then(obsSetList => {
            if (obsSetList) {
              // We only draw the Line charts if all ObservationSets are of
              // the same type of y-value: continuous or discrete.
              if (obsSetList.length > 0 &&
                  obsSetList.every(obsSet => obsSet.allQualitative)) {
                return LineGraphData.fromObservationSetListDiscrete(
                    this.displayConcept.label, obsSetList);
              } else if (obsSetList.every(obsSet => !obsSet.allQualitative)) {
                return LineGraphData.fromObservationSetList(
                    this.displayConcept.label, obsSetList);
              } else {
                throw Error(
                    'ObservationSets must all be continous ' +
                    'or discrete-valued.');
              }
            }
          });
    }
  }

  /**
   * Get the data needed for the medication summary.
   * We first get the MedicationAdministrations corresponding to the RxNorms to
   * display on the page, and group them by order id (representing a
   * prescription). We then get the MedicationOrder for each order id, and group
   * those into MedicationOrderSets, where each MedicationOrderSet represents a
   * set of MedicationOrders for a particular medication.
   * @param rxNorms The RxNorms to be displayed in the StepGraphCard.
   */
  getStepGraphDataForMedicationSummary(rxNorms: RxNormCodeGroup):
      Promise<StepGraphData> {
    return rxNorms.getResourceFromFhir(this.dateRange).then(medOrderSets => {
      return StepGraphData.fromMedicationOrderSetList(
          medOrderSets.map(x => x.orders), this.dateRange);
    });
  }

  getStepGraphDataForMB(bchCodes: BCHMicrobioCodeGroup):
      Promise<StepGraphData> {
    return bchCodes.getResourceFromFhir(this.dateRange).then(diagReports => {
      return StepGraphData.fromDiagnosticReports(diagReports, bchCodes.label);
    });
  }

  /**
   * Issues a FHIR request to get all the meds data for a list of
   * RxNorm codes (medications).
   */
  getLineGraphDataForMedicationDetail(rxNorms: RxNormCodeGroup):
      Promise<LineGraphData> {
    return rxNorms.getResourceFromFhir(this.dateRange)
        .then(rxNs => {
          const medOrders: MedicationOrder[] =
              [].concat(...rxNs.map(rx => rx.orders.resourceList));
          return medOrders.map(
              order => order.setMedicationAdministrations(this.fhirService));
        })
        .then(orders => {
          return Promise.all(orders);
        })
        .then(orders => {
          return LineGraphData.fromMedicationOrderSet(
              new MedicationOrderSet(orders), this.dateRange);
        });
  }
}