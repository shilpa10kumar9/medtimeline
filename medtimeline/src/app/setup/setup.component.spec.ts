// Copyright 2018 Verily Life Sciences Inc.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

import {async, ComponentFixture, fakeAsync, TestBed} from '@angular/core/testing';
import {FormsModule, ReactiveFormsModule} from '@angular/forms';
import {MatCheckboxModule, MatFormFieldModule, MatInputModule, MatToolbarModule} from '@angular/material';
import {BrowserAnimationsModule} from '@angular/platform-browser/animations';
import {ActivatedRoute, Router} from '@angular/router';

import {ResourceCodeManager} from '../clinicalconcepts/resource-code-manager';
import {StubFhirService} from '../test_utils';

import {SetupComponent} from './setup.component';

const resourceCodeManagerStub = new ResourceCodeManager(new StubFhirService());
describe('SetupComponent', () => {
  let component: SetupComponent;
  let fixture: ComponentFixture<SetupComponent>;

  beforeEach(async(() => {
    TestBed
        .configureTestingModule({
          declarations: [SetupComponent],
          imports: [
            MatToolbarModule, MatCheckboxModule, MatFormFieldModule,
            ReactiveFormsModule, FormsModule, MatInputModule,
            BrowserAnimationsModule
          ],
          providers: [
            {provide: ResourceCodeManager, useValue: resourceCodeManagerStub},
            {provide: ActivatedRoute, useValue: {}},
            {provide: Router, useValue: {}}
          ]
        })
        .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SetupComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should filter concepts based on input', fakeAsync(() => {
       const userInput = 'CB';
       const filtered = component.filter(userInput);
       expect(filtered.length).toEqual(1);
       const element = filtered[0];
       expect(element[0].label).toEqual('Lab Results');
       expect(element[1].length).toEqual(2);
       expect(element[1][0].label).toEqual('CBC');
       expect(element[1][1].label).toEqual('CBC White Blood Cell');
     }));
});
